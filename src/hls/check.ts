import { createDecipheriv } from 'node:crypto';
import path from 'node:path';
import { parseMediaPlaylist, type MediaPlaylist, type Segment } from './playlist.ts';

/**
 * Checks a stream against the invariants players depend on (and this encoder promises):
 * - each variant's segment N starts on a keyframe at the same timestamp in every variant, so ABR switches are clean;
 * - discontinuities line up across variants;
 * - EXTINF rounded to whole seconds never exceeds EXT-X-TARGETDURATION (RFC 8216 4.3.3.1);
 * - live playlists carry EXT-X-DISCONTINUITY-SEQUENCE, and it agrees across variants at the same media sequence.
 */

export interface Loader {
  text(ref: string): Promise<string>;
  bytes(ref: string): Promise<Uint8Array>;
}

export interface FirstVideoPacket {
  ptsSec: number;
  keyframe: boolean;
}

/** Reads the first video packet of a segment (with its init section prepended for fMP4); null if it has no video. */
export type ProbeSegment = (data: Uint8Array) => Promise<FirstVideoPacket | null>;

export interface CheckOptions {
  loader: Loader;
  probeSegment: ProbeSegment;
  /** How many of the newest segments every variant has in common to compare. */
  segments: number;
}

export interface VariantReport {
  uri: string;
  live: boolean;
  targetDuration: number | null;
  mediaSequence: number;
  discontinuitySequence: number | null;
  segmentCount: number;
}

export interface AlignmentRow {
  seq: number;
  /** First video packet per variant, in master order; null where the segment has no video. */
  packets: Array<FirstVideoPacket | null>;
}

export interface CheckReport {
  variants: VariantReport[];
  alignment: AlignmentRow[];
  problems: string[];
}

/** Two variants' segment N may start this far apart and still count as aligned (well under one frame). */
const PTS_TOLERANCE_SEC = 0.01;

/** Resolves a playlist URI against the playlist that contains it, for URLs and local paths alike. */
export function resolveRef(base: string, uri: string): string {
  if (/^https?:\/\//.test(base)) return new URL(uri, base).toString();
  return path.resolve(path.dirname(base), uri);
}

/** Variant playlist URIs from a master playlist, in order. */
export function parseMasterPlaylist(text: string): string[] {
  const lines = text.split('\n').map((line) => line.trim());
  const uris: string[] = [];
  lines.forEach((line, i) => {
    if (!line.startsWith('#EXT-X-STREAM-INF')) return;
    const uri = lines.slice(i + 1).find((next) => next !== '' && !next.startsWith('#'));
    if (uri !== undefined) uris.push(uri);
  });
  return uris;
}

function tagValue(text: string, tag: string): string | null {
  const line = text.split('\n').find((l) => l.trim().startsWith(`${tag}:`));
  return line === undefined ? null : line.trim().slice(tag.length + 1);
}

function extinf(tags: string[]): number | null {
  const tag = tags.find((t) => t.startsWith('#EXTINF:'));
  if (tag === undefined) return null;
  const value = Number.parseFloat(tag.slice('#EXTINF:'.length));
  return Number.isFinite(value) ? value : null;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const MAP_URI = /URI="([^"]+)"/;
const IV = /IV=0[xX]([0-9a-fA-F]{32})/;

/**
 * AES-128 segments (RFC 8216 5.2): CBC with the key from the tag's URI and its IV, or, without one, the segment's
 * media sequence number as a 128-bit big-endian integer.
 */
export function decryptSegment(data: Uint8Array, key: Uint8Array, segment: Pick<Segment, 'key' | 'seq'>): Uint8Array {
  const explicit = segment.key === null ? undefined : IV.exec(segment.key)?.[1];
  const iv = Buffer.alloc(16);
  if (explicit !== undefined) Buffer.from(explicit, 'hex').copy(iv);
  else iv.writeBigUInt64BE(BigInt(segment.seq), 8);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
}

export async function checkHls(masterRef: string, options: CheckOptions): Promise<CheckReport> {
  const { loader, probeSegment } = options;
  const problems: string[] = [];
  const uris = parseMasterPlaylist(await loader.text(masterRef));
  if (uris.length === 0) return { variants: [], alignment: [], problems: ['master playlist lists no variants'] };

  const refs = uris.map((uri) => resolveRef(masterRef, uri));
  const texts = await Promise.all(refs.map((ref) => loader.text(ref)));
  const playlists: MediaPlaylist[] = texts.map((text) => parseMediaPlaylist(text));

  const variants = playlists.map((playlist, i): VariantReport => {
    const text = texts[i] ?? '';
    const uri = uris[i] ?? '';
    const target = tagValue(text, '#EXT-X-TARGETDURATION');
    const discSeq = tagValue(text, '#EXT-X-DISCONTINUITY-SEQUENCE');
    const live = playlist.trailer.every((t) => !t.startsWith('#EXT-X-ENDLIST'));
    const targetDuration = target === null ? null : Number.parseInt(target, 10);

    if (targetDuration === null) problems.push(`${uri}: no EXT-X-TARGETDURATION`);
    for (const segment of playlist.segments) {
      const duration = extinf(segment.tags);
      if (duration !== null && targetDuration !== null && Math.round(duration) > targetDuration) {
        problems.push(`${uri}: ${segment.uri} lasts ${duration}s, over the ${targetDuration}s target duration`);
      }
    }
    if (live && discSeq === null) problems.push(`${uri}: live playlist without EXT-X-DISCONTINUITY-SEQUENCE`);
    return {
      uri,
      live,
      targetDuration,
      mediaSequence: playlist.mediaSequence,
      discontinuitySequence: discSeq === null ? null : Number.parseInt(discSeq, 10),
      segmentCount: playlist.segments.length,
    };
  });

  // Variants fetched at slightly different moments may disagree by a segment; compare where they overlap.
  const bySeq = playlists.map((p) => new Map(p.segments.map((s) => [s.seq, s])));
  const common = (playlists[0]?.segments ?? [])
    .map((s) => s.seq)
    .filter((seq) => bySeq.every((segments) => segments.has(seq)));
  if (common.length === 0) problems.push('the variants have no media sequence numbers in common');

  const sameStart = variants.filter((v) => v.mediaSequence === variants[0]?.mediaSequence);
  if (new Set(sameStart.map((v) => v.discontinuitySequence)).size > 1) {
    problems.push('variants at the same media sequence disagree on EXT-X-DISCONTINUITY-SEQUENCE');
  }

  const alignment: AlignmentRow[] = [];
  for (const seq of common.slice(-options.segments)) {
    const segments = bySeq.map((m) => m.get(seq));
    if (new Set(segments.map((s) => s?.discontinuity)).size > 1) {
      problems.push(`segment ${seq}: EXT-X-DISCONTINUITY in some variants only`);
    }
    const packets = await Promise.all(
      segments.map(async (segment, i) => {
        if (segment === undefined) return null;
        const ref = refs[i] ?? '';
        let data = await loader.bytes(resolveRef(ref, segment.uri));
        const keyUri = segment.key === null ? undefined : MAP_URI.exec(segment.key)?.[1];
        if (keyUri !== undefined) data = decryptSegment(data, await loader.bytes(resolveRef(ref, keyUri)), segment);
        const init = segment.map === null ? undefined : MAP_URI.exec(segment.map)?.[1];
        if (init !== undefined) data = concat(await loader.bytes(resolveRef(ref, init)), data);
        return probeSegment(data);
      }),
    );
    alignment.push({ seq, packets });

    packets.forEach((packet, i) => {
      if (packet !== null && !packet.keyframe) problems.push(`segment ${seq} of ${uris[i]} does not start with a keyframe`);
    });
    const starts = packets.filter((p): p is FirstVideoPacket => p !== null).map((p) => p.ptsSec);
    if (starts.length > 1 && Math.max(...starts) - Math.min(...starts) > PTS_TOLERANCE_SEC) {
      problems.push(`segment ${seq} starts at different times across variants: ${starts.map((s) => s.toFixed(3)).join(', ')}`);
    }
  }
  return { variants, alignment, problems };
}
