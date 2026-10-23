/**
 * Checks a stream's playlists and segments against the invariants in src/hls/check.ts.
 * Usage: npm run check:hls -- <master.m3u8 URL or path> [segments to compare, default 3]
 * Exits 1 when it finds a problem, so it can run in scripts.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '../config.ts';
import { checkHls, type FirstVideoPacket, type Loader } from '../hls/check.ts';

const execFileAsync = promisify(execFile);

const isUrl = (ref: string): boolean => /^https?:\/\//.test(ref);

async function fetchOk(ref: string): Promise<Response> {
  const res = await fetch(ref);
  if (!res.ok) throw new Error(`GET ${ref}: HTTP ${res.status}`);
  return res;
}

const loader: Loader = {
  text: async (ref) => (isUrl(ref) ? (await fetchOk(ref)).text() : readFile(ref, 'utf8')),
  bytes: async (ref) => (isUrl(ref) ? new Uint8Array(await (await fetchOk(ref)).arrayBuffer()) : readFile(ref)),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function main(): Promise<number> {
  const [master, count] = process.argv.slice(2);
  if (master === undefined) {
    console.error('usage: npm run check:hls -- <master.m3u8 URL or path> [segments to compare]');
    return 2;
  }
  const { ffprobePath } = loadConfig();
  const dir = await mkdtemp(path.join(tmpdir(), 'check-hls-'));
  let n = 0;
  const probeSegment = async (data: Uint8Array): Promise<FirstVideoPacket | null> => {
    const file = path.join(dir, `segment-${n++}`);
    await writeFile(file, data);
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1',
      '-show_entries', 'packet=pts_time,flags', '-of', 'json', file,
    ]);
    const parsed: unknown = JSON.parse(stdout);
    const packet = isRecord(parsed) && Array.isArray(parsed.packets) ? parsed.packets.find(isRecord) : undefined;
    if (packet === undefined) return null;
    return { ptsSec: Number(packet.pts_time), keyframe: typeof packet.flags === 'string' && packet.flags.startsWith('K') };
  };

  try {
    const report = await checkHls(isUrl(master) ? master : path.resolve(master), {
      loader,
      probeSegment,
      segments: count === undefined ? 3 : Number(count),
    });
    console.log('variants:');
    for (const v of report.variants) {
      const disc = v.discontinuitySequence === null ? '-' : String(v.discontinuitySequence);
      console.log(
        `  ${v.uri.padEnd(22)} ${v.live ? 'live' : 'vod '}  target ${v.targetDuration ?? '?'}s  ` +
          `media seq ${v.mediaSequence}  disc seq ${disc}  ${v.segmentCount} segments`,
      );
    }
    console.log('segment start (first video packet; K = keyframe), per variant:');
    for (const row of report.alignment) {
      const cells = row.packets.map((p) => (p === null ? 'no video' : `${p.ptsSec.toFixed(3)}${p.keyframe ? ' K' : '  '}`));
      console.log(`  #${String(row.seq).padEnd(6)} ${cells.join('   ')}`);
    }
    if (report.problems.length === 0) {
      console.log('OK: no problems found');
      return 0;
    }
    console.log(`${report.problems.length} problem(s):`);
    for (const problem of report.problems) console.log(`  - ${problem}`);
    return 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

process.exitCode = await main();
