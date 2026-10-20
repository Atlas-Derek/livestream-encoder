import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from '../log.ts';

const execFileAsync = promisify(execFile);

export type IsFfmpegFn = (pid: number) => Promise<boolean>;

/** Asks ps for the command name so a recycled pid belonging to something else is never killed. */
export const isFfmpegProcess: IsFfmpegFn = async (pid) => {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm=']);
    return path.basename(stdout.trim()) === 'ffmpeg';
  } catch {
    return false; // ps exits non-zero when the pid doesn't exist
  }
};

export async function writePidFile(pidDir: string, id: string, pid: number | null): Promise<void> {
  const file = path.join(pidDir, `${id}.pid`);
  if (pid === null) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(pidDir, { recursive: true });
  await writeFile(file, `${pid}\n`);
}

/**
 * Kills ffmpeg processes left behind by a previous run that died without cleaning up (e.g. kill -9).
 * A listener waiting for a publisher writes nothing, so it never notices its parent is gone and keeps the port.
 */
export async function killStaleFfmpeg(pidDir: string, logger: Logger, isFfmpeg: IsFfmpegFn = isFfmpegProcess): Promise<number[]> {
  await mkdir(pidDir, { recursive: true });
  const killed: number[] = [];
  for (const name of await readdir(pidDir)) {
    if (!name.endsWith('.pid')) continue;
    const file = path.join(pidDir, name);
    const pid = Number((await readFile(file, 'utf8')).trim());
    if (Number.isInteger(pid) && pid > 0 && (await isFfmpeg(pid))) {
      try {
        process.kill(pid, 'SIGKILL');
        killed.push(pid);
        logger.warn({ ffmpegPid: pid, pidFile: name }, 'killed stale ffmpeg from a previous run');
      } catch (err) {
        logger.error({ ffmpegPid: pid, pidFile: name, err }, 'failed to kill stale ffmpeg');
      }
    }
    await rm(file, { force: true });
  }
  return killed;
}
