import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrameRate } from '../ffmpeg/probe.ts';
import { parseMediaPlaylist } from './playlist.ts';

/**
 * Completes the EXT-X-STREAM-INF attributes ffmpeg leaves out, from each variant's first segment.
 * - CODECS: ffmpeg 9 writes none at all for HEVC, not even the audio part, and players then have to guess: Safari
 *   needs it to decide whether it can play a variant. The strings come from the stream's own codec configuration
 *   (ffprobe's extradata), not from guesses, and nothing is written when a codec isn't recognised: a wrong CODECS is
 *   worse than none.
 * - FRAME-RATE: ffmpeg never writes it, and Apple's HLS authoring spec requires it for video. It is what the segment
 *   really carries, so a rung capped by maxFps reports its own rate, and push sources (unknown up front) are covered.
 */

/** Reads ffprobe's -show_data hexdump ("00000000: 0101 6000 …  ..`.") back into bytes. */
export function parseHexdump(dump: string): Uint8Array {
  const bytes: number[] = [];
  for (const line of dump.split('\n')) {
    const match = /^[0-9a-f]{8}: ((?:[0-9a-f]{2,4} ?)+)/i.exec(line.trim());
    if (match?.[1] === undefined) continue;
    for (const group of match[1].trim().split(/\s+/)) {
      for (let i = 0; i < group.length; i += 2) bytes.push(Number.parseInt(group.slice(i, i + 2), 16));
    }
  }
  return Uint8Array.from(bytes);
}

/** NAL units of an Annex B byte stream (00 00 01 / 00 00 00 01 start codes), without the start codes. */
function annexBNalUnits(data: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  return starts.map((start, n) => {
    let end = starts[n + 1] === undefined ? data.length : (starts[n + 1] ?? data.length) - 3;
    while (end > start && data[end - 1] === 0) end--; // the extra 0 of a 4-byte start code
    return data.subarray(start, end);
  });
}

/** Drops the emulation-prevention 03 in every 00 00 03, turning a NAL payload back into its RBSP. */
function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    const byte = nal[i] ?? 0;
    if (byte === 3 && i >= 2 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(byte);
  }
  return Uint8Array.from(out);
}

const isAnnexB = (data: Uint8Array): boolean => data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1));

/** The 12-byte general profile_tier_level: space/tier/profile, 4 compatibility bytes, 6 constraint bytes, level. */
function hevcProfileTierLevel(extradata: Uint8Array): Uint8Array | null {
  if (isAnnexB(extradata)) {
    const sps = annexBNalUnits(extradata).find((nal) => ((nal[0] ?? 0) >> 1 & 0x3f) === 33);
    if (sps === undefined) return null;
    // 2-byte NAL header, then 1 byte of sps_video_parameter_set_id / max_sub_layers / temporal_id_nesting.
    const rbsp = unescapeRbsp(sps.subarray(2));
    return rbsp.length >= 13 ? rbsp.subarray(1, 13) : null;
  }
  // HEVCDecoderConfigurationRecord (hvcC): configurationVersion, then the same 12 bytes.
  return extradata[0] === 1 && extradata.length >= 13 ? extradata.subarray(1, 13) : null;
}

function reverseBits32(value: number): number {
  let out = 0;
  for (let i = 0; i < 32; i++) out = (out << 1) | ((value >>> i) & 1);
  return out >>> 0;
}

/** ISO/IEC 14496-15 Annex E, e.g. hvc1.1.6.L120.90 (Main, level 4). */
export function hevcCodecString(extradata: Uint8Array, sampleEntry: 'hvc1' | 'hev1'): string | null {
  const ptl = hevcProfileTierLevel(extradata);
  if (ptl === null) return null;
  const first = ptl[0] ?? 0;
  const space = ['', 'A', 'B', 'C'][first >> 6] ?? '';
  const tier = (first >> 5) & 1 ? 'H' : 'L';
  const profile = first & 0x1f;
  const compatibility = reverseBits32((((ptl[1] ?? 0) << 24) | ((ptl[2] ?? 0) << 16) | ((ptl[3] ?? 0) << 8) | (ptl[4] ?? 0)) >>> 0);
  const constraints = [...ptl.subarray(5, 11)];
  while (constraints.length > 0 && constraints.at(-1) === 0) constraints.pop(); // trailing zero bytes are omitted
  const hex = (n: number): string => n.toString(16).toUpperCase();
  return [`${sampleEntry}.${space}${profile}`, hex(compatibility), `${tier}${ptl[11] ?? 0}`, ...constraints.map(hex)].join('.');
}

/** RFC 6381, e.g. avc1.640028: profile_idc, constraint flags, level_idc. */
export function avcCodecString(extradata: Uint8Array): string | null {
  let bytes: Uint8Array | null = null;
  if (isAnnexB(extradata)) {
    const sps = annexBNalUnits(extradata).find((nal) => ((nal[0] ?? 0) & 0x1f) === 7);
    if (sps !== undefined) bytes = unescapeRbsp(sps.subarray(1));
  } else if (extradata[0] === 1 && extradata.length >= 4) {
    bytes = extradata.subarray(1); // AVCDecoderConfigurationRecord (avcC)
  }
  if (bytes === null || bytes.length < 3) return null;
  return `avc1.${[...bytes.subarray(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const AAC_OBJECT_TYPES: Record<string, number> = { LC: 2, 'HE-AAC': 5, 'HE-AACv2': 29 };

export function audioCodecString(codec: string, profile: string | null): string | null {
  if (codec === 'aac') {
    const objectType = AAC_OBJECT_TYPES[profile ?? 'LC'];
    return objectType === undefined ? null : `mp4a.40.${objectType}`;
  }
  return { mp3: 'mp4a.40.34', ac3: 'ac-3', eac3: 'ec-3' }[codec] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The CODECS value for a segment, from ffprobe -show_streams -show_data JSON; null if any stream is unknown. */
export function codecsFromProbe(json: unknown): string | null {
  const streams = isRecord(json) && Array.isArray(json.streams) ? json.streams.filter(isRecord) : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const parts: string[] = [];
  if (video !== undefined) {
    const extradata = parseHexdump(str(video.extradata) ?? '');
    const codec = str(video.codec_name);
    // In MPEG-TS the tag is a stream type, not a sample entry; parameter sets are in-band there, as with hev1.
    const sample = str(video.codec_tag_string) === 'hvc1' ? 'hvc1' : 'hev1';
    const value = codec === 'hevc' ? hevcCodecString(extradata, sample) : codec === 'h264' ? avcCodecString(extradata) : null;
    if (value === null) return null;
    parts.push(value);
  }
  if (audio !== undefined) {
    const value = audioCodecString(str(audio.codec_name) ?? '', str(audio.profile));
    if (value === null) return null;
    parts.push(value);
  }
  return parts.length > 0 ? parts.join(',') : null;
}

/** The video frame rate of a segment, from ffprobe -show_streams JSON; null without video or a known rate. */
export function frameRateFromProbe(json: unknown): number | null {
  const streams = isRecord(json) && Array.isArray(json.streams) ? json.streams.filter(isRecord) : [];
  const video = streams.find((s) => s.codec_type === 'video');
  return video === undefined ? null : (parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate));
}

/** Runs ffprobe -show_streams -show_data on a segment, with its init section prepended for fMP4. */
export type ProbeSegmentStreams = (segment: string, init: string | null) => Promise<unknown>;

export interface MasterStreamInfo {
  text: string;
  /** False while a variant missing an attribute has no segment to read yet; publish again later. */
  complete: boolean;
  /** Variants whose segment couldn't be read or whose codecs aren't recognised; they go without. */
  errors: string[];
}

const MAP_URI = /URI="([^"]+)"/;

/** Adds CODECS and FRAME-RATE to every EXT-X-STREAM-INF that lacks them, reading the first segment of that variant. */
export async function fillStreamInfo(
  master: string,
  outDir: string,
  probeStreams: ProbeSegmentStreams,
): Promise<MasterStreamInfo> {
  const lines = master.split('\n');
  let complete = true;
  const errors: string[] = [];
  for (const [i, line] of lines.entries()) {
    const needsCodecs = !line.includes('CODECS=');
    const needsFrameRate = !line.includes('FRAME-RATE=');
    if (!line.startsWith('#EXT-X-STREAM-INF:') || (!needsCodecs && !needsFrameRate)) continue;
    const uri = lines.slice(i + 1).find((next) => next.trim() !== '' && !next.startsWith('#'))?.trim();
    if (uri === undefined) continue;
    const playlistPath = path.join(outDir, uri);
    try {
      const playlist = parseMediaPlaylist(await readFile(playlistPath, 'utf8'));
      const first = playlist.segments[0];
      if (first === undefined) {
        complete = false;
        continue;
      }
      const dir = path.dirname(playlistPath);
      const init = first.map === null ? undefined : MAP_URI.exec(first.map)?.[1];
      const streams = await probeStreams(path.join(dir, first.uri), init === undefined ? null : path.join(dir, init));
      let filled = line;
      if (needsCodecs) {
        const codecs = codecsFromProbe(streams);
        if (codecs === null) errors.push(`${uri}: unrecognised codecs, CODECS left out`);
        else filled += `,CODECS="${codecs}"`;
      }
      const frameRate = needsFrameRate ? frameRateFromProbe(streams) : null;
      if (frameRate !== null) filled += `,FRAME-RATE=${frameRate.toFixed(3)}`; // RFC 8216: three decimal places
      lines[i] = filled;
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') complete = false; // not written yet
      else errors.push(`${uri}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { text: lines.join('\n'), complete, errors };
}
