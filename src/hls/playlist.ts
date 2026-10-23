/**
 * Live channels don't serve ffmpeg's playlists directly. ffmpeg writes ffmpeg.m3u8 per variant and
 * ffmpeg-master.m3u8, and the publisher turns them into the index.m3u8 and master.m3u8 that players fetch, because
 * ffmpeg's own output is wrong once a channel has restarted (verified with ffmpeg 9):
 * - it never writes EXT-X-DISCONTINUITY-SEQUENCE, which RFC 8216 requires once a discontinuity leaves the window;
 * - with fMP4 it writes a single EXT-X-MAP for its own run, so segments from earlier runs still in the window are
 *   paired with the wrong init section.
 * Segment names carry the run id (seg_<runId>_<n>), so run boundaries can be read from the names. Everything else
 * (earlier runs' init sections, how many discontinuities have left) comes from the previously published playlist.
 */
export const FFMPEG_MEDIA_PLAYLIST = 'ffmpeg.m3u8';
export const FFMPEG_MASTER_PLAYLIST = 'ffmpeg-master.m3u8';
export const MEDIA_PLAYLIST = 'index.m3u8';
export const MASTER_PLAYLIST = 'master.m3u8';

const SEGMENT_NAME = /^seg_([a-z0-9]+)_\d+\.(?:ts|m4s)$/;
const MAP_URI = /URI="([^"]+)"/;

export interface Segment {
  seq: number;
  uri: string;
  /** From seg_<runId>_<n>; '' for names from before run ids. */
  runId: string;
  discontinuity: boolean;
  /** The EXT-X-MAP line in effect for this segment (fMP4), or null. */
  map: string | null;
  /** EXTINF, EXT-X-PROGRAM-DATE-TIME and any other per-segment tags, in order. */
  tags: string[];
}

export interface MediaPlaylist {
  /** Playlist-level tags, except the sequence numbers, which are written separately. */
  header: string[];
  mediaSequence: number;
  discontinuitySequence: number;
  segments: Segment[];
  /** Tags after the last segment, e.g. EXT-X-ENDLIST. */
  trailer: string[];
}

const PLAYLIST_TAGS = new Set([
  '#EXTM3U',
  '#EXT-X-VERSION',
  '#EXT-X-TARGETDURATION',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-PLAYLIST-TYPE',
  '#EXT-X-START',
  '#EXT-X-ALLOW-CACHE',
]);

function tagName(line: string): string {
  const colon = line.indexOf(':');
  return colon === -1 ? line : line.slice(0, colon);
}

function tagInt(line: string): number {
  const value = Number.parseInt(line.slice(line.indexOf(':') + 1), 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const header: string[] = [];
  const trailer: string[] = [];
  const segments: Segment[] = [];
  let mediaSequence = 0;
  let discontinuitySequence = 0;
  let map: string | null = null;
  let discontinuity = false;
  let tags: string[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith('#')) {
      const runId = SEGMENT_NAME.exec(line)?.[1] ?? '';
      segments.push({ seq: mediaSequence + segments.length, uri: line, runId, discontinuity, map, tags });
      discontinuity = false;
      tags = [];
      continue;
    }
    const name = tagName(line);
    if (name === '#EXT-X-MEDIA-SEQUENCE') mediaSequence = tagInt(line);
    else if (name === '#EXT-X-DISCONTINUITY-SEQUENCE') discontinuitySequence = tagInt(line);
    else if (name === '#EXT-X-DISCONTINUITY') discontinuity = true;
    else if (name === '#EXT-X-MAP') map = line;
    else if (name === '#EXT-X-ENDLIST') trailer.push(line);
    else if (PLAYLIST_TAGS.has(name)) header.push(line);
    else if (name.startsWith('#EXT')) tags.push(line);
    // Anything else starting with # is a comment.
  }
  return { header, mediaSequence, discontinuitySequence, segments, trailer };
}

export function formatMediaPlaylist(playlist: MediaPlaylist): string {
  const lines = [
    ...playlist.header,
    `#EXT-X-MEDIA-SEQUENCE:${playlist.mediaSequence}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${playlist.discontinuitySequence}`,
  ];
  let map: string | null = null;
  for (const segment of playlist.segments) {
    if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (segment.map !== null && segment.map !== map) {
      lines.push(segment.map);
      map = segment.map;
    }
    lines.push(...segment.tags, segment.uri);
  }
  lines.push(...playlist.trailer);
  return `${lines.join('\n')}\n`;
}

function startsRun(segment: Segment, predecessor: Segment | undefined): boolean {
  if (predecessor === undefined) return false;
  // Names from before run ids can't be told apart, so trust ffmpeg's own tag for them.
  if (segment.runId === '' && predecessor.runId === '') return segment.discontinuity;
  return segment.runId !== predecessor.runId;
}

/** Pure: the variant playlist players should see, from ffmpeg's playlist and the one published before it. */
export function publishMediaPlaylist(source: string, previous: string | null): string {
  const next = parseMediaPlaylist(source);
  const prev = previous === null ? null : parseMediaPlaylist(previous);
  const prevSegments = prev?.segments ?? [];
  const first = next.mediaSequence;

  // Each run's init section as last published. ffmpeg's playlist only has the current run's.
  const maps = new Map<string, string | null>(prevSegments.map((s) => [s.runId, s.map]));
  const current = next.segments.at(-1);
  if (current !== undefined) maps.set(current.runId, current.map);

  // A discontinuity tag leaves the playlist together with the segment it precedes.
  const removed = prevSegments.filter((s) => s.seq < first && s.discontinuity).length;

  let predecessor = prevSegments.filter((s) => s.seq < first).at(-1);
  const segments: Segment[] = [];
  for (const [i, segment] of next.segments.entries()) {
    // The first segment's predecessor has already left, so keep whatever was published for it.
    const published = i === 0 ? prevSegments.find((s) => s.seq === segment.seq && s.uri === segment.uri) : undefined;
    const out: Segment = {
      ...segment,
      discontinuity: published?.discontinuity ?? startsRun(segment, predecessor),
      map: maps.get(segment.runId) ?? segment.map,
    };
    segments.push(out);
    predecessor = out;
  }

  return formatMediaPlaylist({
    ...next,
    discontinuitySequence: (prev?.discontinuitySequence ?? 0) + removed,
    segments,
  });
}

/** The master playlist players should see: ffmpeg's, pointing at the published variant playlists. */
export function publishMasterPlaylist(source: string): string {
  return source
    .split('\n')
    .map((line) =>
      !line.startsWith('#') && (line === FFMPEG_MEDIA_PLAYLIST || line.endsWith(`/${FFMPEG_MEDIA_PLAYLIST}`))
        ? `${line.slice(0, -FFMPEG_MEDIA_PLAYLIST.length)}${MEDIA_PLAYLIST}`
        : line,
    )
    .join('\n');
}

/** Files a media playlist refers to: its segments and init sections. */
export function playlistReferences(text: string): Set<string> {
  const refs = new Set<string>();
  for (const segment of parseMediaPlaylist(text).segments) {
    refs.add(segment.uri);
    const init = segment.map === null ? undefined : MAP_URI.exec(segment.map)?.[1];
    if (init !== undefined) refs.add(init);
  }
  return refs;
}
