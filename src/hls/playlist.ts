/**
 * Live channels don't serve ffmpeg's playlists directly. ffmpeg writes ffmpeg.m3u8 per variant and
 * ffmpeg-master.m3u8, and the publisher turns them into the index.m3u8 and master.m3u8 that players fetch, because
 * ffmpeg's own output is wrong once a channel has restarted (verified with ffmpeg 9):
 * - it never writes EXT-X-DISCONTINUITY-SEQUENCE, which RFC 8216 requires once a discontinuity leaves the window;
 * - with fMP4 it writes a single EXT-X-MAP for its own run, so segments from earlier runs still in the window are
 *   paired with the wrong init section.
 * The published playlist is an append log with its own window: each new segment of ffmpeg's is appended, and while the
 * source is down, slate segments are (appendSlateSegment), so players keep playing instead of stalling. Its sequence
 * numbers are its own, since slate segments take numbers ffmpeg doesn't know about; a comment records the last of
 * ffmpeg's sequence numbers already published. Segment names carry the run id (seg_<runId>_<n>), so run boundaries can
 * be read from the names. Earlier runs' init sections come from the previously published playlist.
 */
export const FFMPEG_MEDIA_PLAYLIST = 'ffmpeg.m3u8';
export const FFMPEG_MASTER_PLAYLIST = 'ffmpeg-master.m3u8';
export const MEDIA_PLAYLIST = 'index.m3u8';
export const MASTER_PLAYLIST = 'master.m3u8';
/** Per variant: the pre-rendered slate, a short VOD playlist of slate_<id>_<n> segments (see buildSlateArgs). */
export const SLATE_PLAYLIST = 'slate.m3u8';

const SEGMENT_NAME = /^seg_([a-z0-9]+)_\d+\.(?:ts|m4s)$/;
const SLATE_NAME = /^slate_[a-z0-9]+_\d+\.(?:ts|m4s)$/;
const MAP_URI = /URI="([^"]+)"/;
/** A comment (ignored by players): the last of ffmpeg's media sequence numbers already published. */
const SOURCE_SEQUENCE = '## source-sequence:';

export interface Segment {
  seq: number;
  uri: string;
  /** From seg_<runId>_<n>; '' for names from before run ids, and for slate segments. */
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
  /** Published playlists only: the last of ffmpeg's media sequence numbers they include. */
  sourceSequence: number | null;
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

export function isSlate(uri: string): boolean {
  return SLATE_NAME.test(uri);
}

/** A segment's EXTINF duration in seconds, or 0. */
export function segmentDuration(segment: Segment): number {
  const extinf = segment.tags.find((tag) => tag.startsWith('#EXTINF:'));
  const value = extinf === undefined ? Number.NaN : Number.parseFloat(extinf.slice('#EXTINF:'.length));
  return Number.isFinite(value) ? value : 0;
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const header: string[] = [];
  const trailer: string[] = [];
  const segments: Segment[] = [];
  let mediaSequence = 0;
  let discontinuitySequence = 0;
  let sourceSequence: number | null = null;
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
    if (line.startsWith(SOURCE_SEQUENCE)) {
      sourceSequence = tagInt(line);
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
  return { header, mediaSequence, discontinuitySequence, sourceSequence, segments, trailer };
}

export function formatMediaPlaylist(playlist: MediaPlaylist): string {
  const lines = [
    ...playlist.header,
    `#EXT-X-MEDIA-SEQUENCE:${playlist.mediaSequence}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${playlist.discontinuitySequence}`,
    ...(playlist.sourceSequence === null ? [] : [`${SOURCE_SEQUENCE}${playlist.sourceSequence}`]),
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
  if (isSlate(predecessor.uri)) return true;
  // Names from before run ids can't be told apart, so trust ffmpeg's own tag for them.
  if (segment.runId === '' && predecessor.runId === '') return segment.discontinuity;
  return segment.runId !== predecessor.runId;
}

/**
 * The published playlist after appending `added` to `prev` and trimming it to windowSize segments. A discontinuity
 * tag leaves together with the segment it precedes, which advances the discontinuity sequence.
 */
function appendAndTrim(
  prev: MediaPlaylist | null,
  header: string[],
  added: Segment[],
  windowSize: number,
  sourceSequence: number | null,
): MediaPlaylist {
  const all = [...(prev?.segments ?? []), ...added];
  const removed = all.slice(0, Math.max(0, all.length - windowSize));
  const segments = all.slice(removed.length);
  const firstSeq = prev?.mediaSequence ?? added[0]?.seq ?? 0;
  const mediaSequence = firstSeq + removed.length;
  // RFC 8216: every EXTINF, rounded, must fit the target duration. Slate segments and earlier runs' segments may be
  // longer than ffmpeg's current window suggests.
  const longest = Math.max(0, ...segments.map(segmentDuration));
  const header2 = header.map((line) =>
    tagName(line) === '#EXT-X-TARGETDURATION' ? `#EXT-X-TARGETDURATION:${Math.max(tagInt(line), Math.round(longest))}` : line,
  );
  return {
    header: header2,
    mediaSequence,
    discontinuitySequence: (prev?.discontinuitySequence ?? 0) + removed.filter((s) => s.discontinuity).length,
    sourceSequence,
    segments: segments.map((segment, i) => ({ ...segment, seq: mediaSequence + i })),
    trailer: [],
  };
}

/** The last of ffmpeg's sequence numbers a published playlist includes; older ones lack the comment. */
function publishedSourceSequence(prev: MediaPlaylist | null): number | null {
  if (prev === null) return null;
  if (prev.sourceSequence !== null) return prev.sourceSequence;
  const last = prev.segments.at(-1); // written before the publisher numbered its own segments: the same numbers
  return last === undefined || isSlate(last.uri) ? null : last.seq;
}

/**
 * ffmpeg's segments that a published playlist doesn't include yet: those after the last of ffmpeg's numbers it records.
 * reset: ffmpeg's numbering went back (its playlist was deleted), so all of them are new.
 */
export function unpublishedSegments(
  next: MediaPlaylist,
  prev: MediaPlaylist | null,
): { segments: Segment[]; reset: boolean } {
  const watermark = publishedSourceSequence(prev);
  const lastSource = next.segments.at(-1)?.seq;
  if (watermark !== null && lastSource !== undefined && lastSource < watermark) {
    return { segments: next.segments, reset: true };
  }
  return { segments: next.segments.filter((s) => watermark === null || s.seq > watermark), reset: false };
}

/**
 * Pure: the variant playlist players should see, from ffmpeg's playlist and the one published before it. ffmpeg's
 * segments not yet published are appended, then the result is trimmed to windowSize segments.
 */
export function publishMediaPlaylist(source: string, previous: string | null, windowSize: number): string {
  const next = parseMediaPlaylist(source);
  const prev = previous === null ? null : parseMediaPlaylist(previous);
  const { segments: unpublished, reset } = unpublishedSegments(next, prev);

  // Each run's init section as last published. ffmpeg's playlist only has the current run's.
  const maps = new Map<string, string | null>((prev?.segments ?? []).map((s) => [s.runId, s.map]));
  if (next.segments.length > 0) maps.set(next.segments.at(-1)?.runId ?? '', next.segments.at(-1)?.map ?? null);

  let predecessor = prev?.segments.at(-1);
  const added: Segment[] = [];
  for (const segment of unpublished) {
    const out: Segment = {
      ...segment,
      discontinuity: (reset && added.length === 0 && predecessor !== undefined) || startsRun(segment, predecessor),
      map: maps.get(segment.runId) ?? segment.map,
    };
    added.push(out);
    predecessor = out;
  }
  const sourceSequence = added.at(-1)?.seq ?? (reset ? null : publishedSourceSequence(prev));
  const published = appendAndTrim(prev, next.header, added, windowSize, sourceSequence);
  return formatMediaPlaylist({ ...published, trailer: next.trailer });
}

/**
 * Pure: the published playlist with the next slate segment appended, cycling through the slate's segments, or null if
 * there is nothing to continue (no published segment yet, or no slate). Each pass through the slate starts with a
 * discontinuity, its timestamps starting over. Its program date time follows on from the previous segment's.
 */
export function appendSlateSegment(previous: string, slate: string, windowSize: number): string | null {
  const prev = parseMediaPlaylist(previous);
  const slateSegments = parseMediaPlaylist(slate).segments;
  const last = prev.segments.at(-1);
  if (last === undefined || slateSegments.length === 0) return null;
  const index = slateSegments.findIndex((s) => s.uri === last.uri);
  const nextIndex = index === -1 ? 0 : (index + 1) % slateSegments.length;
  const segment = slateSegments[nextIndex];
  if (segment === undefined) return null;

  const tags = segment.tags.filter((tag) => !tag.startsWith('#EXT-X-PROGRAM-DATE-TIME'));
  const lastDate = last.tags.find((tag) => tag.startsWith('#EXT-X-PROGRAM-DATE-TIME:'));
  const lastTime = lastDate === undefined ? Number.NaN : Date.parse(lastDate.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
  if (Number.isFinite(lastTime)) {
    tags.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(lastTime + segmentDuration(last) * 1000).toISOString()}`);
  }
  const added: Segment = { ...segment, runId: '', discontinuity: nextIndex === 0, tags };
  return formatMediaPlaylist(appendAndTrim(prev, prev.header, [added], windowSize, publishedSourceSequence(prev)));
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

/**
 * The start variant's BANDWIDTH ceiling. 720p of the default ladder peaks at about 3.15 Mbps (2800k video, 128k audio,
 * muxing overhead).
 */
export const START_MAX_BANDWIDTH = 3_500_000;

/**
 * Lists first the variant players should start on. Safari and hls.js both start on the first variant listed before
 * they have measured anything, and ffmpeg lists the top rung first, so every viewer began at 5 Mbps and stalled on a
 * slow link. The start variant is the highest whose BANDWIDTH is at most START_MAX_BANDWIDTH (else the lowest); the
 * others keep their order. hls.js sorts variants by bitrate for switching, so only the start changes.
 */
export function orderVariants(master: string): string {
  const lines = master.split('\n');
  const firstVariant = lines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF:'));
  if (firstVariant === -1) return master;
  // Each variant is an EXT-X-STREAM-INF line and its URI. Anything else after the first one (an I-frame playlist,
  // say) isn't understood here, so the playlist is left as it is rather than risk dropping it.
  const variants: Array<{ inf: string; uri: string; bandwidth: number }> = [];
  const rest = lines.slice(firstVariant).filter((line) => line.trim() !== '');
  for (let i = 0; i < rest.length; i += 2) {
    const inf = rest[i] ?? '';
    const uri = rest[i + 1];
    const bandwidth = Number(/[:,]BANDWIDTH=(\d+)/.exec(inf)?.[1]);
    if (!inf.startsWith('#EXT-X-STREAM-INF:') || uri === undefined || uri.startsWith('#') || !Number.isFinite(bandwidth)) {
      return master;
    }
    variants.push({ inf, uri, bandwidth });
  }
  const byBandwidth = [...variants].sort((a, b) => a.bandwidth - b.bandwidth);
  const start = byBandwidth.filter((v) => v.bandwidth <= START_MAX_BANDWIDTH).at(-1) ?? byBandwidth[0];
  if (start === undefined) return master;
  const ordered = [start, ...variants.filter((v) => v !== start)];
  return [...lines.slice(0, firstVariant), ...ordered.map((v) => `${v.inf}\n${v.uri}\n`)].join('\n');
}

/**
 * The longest segment (EXTINF) of the newest run in a media playlist, so earlier runs, which may have come from
 * another publisher, don't count. null without segments.
 */
export function longestSegmentOfLastRun(text: string): { runId: string; seconds: number } | null {
  const { segments } = parseMediaPlaylist(text);
  const runId = segments.at(-1)?.runId;
  if (runId === undefined) return null;
  let seconds = 0;
  for (const segment of segments) {
    if (segment.runId === runId) seconds = Math.max(seconds, segmentDuration(segment));
  }
  return { runId, seconds };
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
