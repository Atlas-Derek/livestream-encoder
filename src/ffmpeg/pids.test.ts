import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { silentLogger } from '../log.ts';
import { killStaleFfmpeg, writePidFile } from './pids.ts';

let pidDir: string;
let children: ChildProcess[] = [];

beforeEach(async () => {
  pidDir = path.join(await mkdtemp(path.join(tmpdir(), 'lse-pids-')), 'pids');
});

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  children = [];
  await rm(path.dirname(pidDir), { recursive: true, force: true });
});

/** A real process standing in for an orphaned ffmpeg; resolves with the signal that ended it. */
function orphan(): { pid: number; ended: Promise<NodeJS.Signals | null> } {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  children.push(child);
  const ended = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
  assert.ok(child.pid);
  return { pid: child.pid, ended };
}

describe('writePidFile', () => {
  it('writes the pid and removes the file when the process is gone', async () => {
    await writePidFile(pidDir, 'ch', 4242);
    assert.equal(await readFile(path.join(pidDir, 'ch.pid'), 'utf8'), '4242\n');
    await writePidFile(pidDir, 'ch', null);
    assert.deepEqual(await readdir(pidDir), []);
    await writePidFile(pidDir, 'ch', null); // already gone
  });
});

describe('killStaleFfmpeg', () => {
  it('kills ffmpeg left by a previous run, spares a recycled pid, and clears every pid file', async () => {
    const stale = orphan();
    const recycled = orphan();
    await writePidFile(pidDir, 'stale', stale.pid);
    await writePidFile(pidDir, 'recycled', recycled.pid);
    await writeFile(path.join(pidDir, 'garbage.pid'), 'not a pid\n');
    await writeFile(path.join(pidDir, 'notes.txt'), 'kept');

    const asked: number[] = [];
    const killed = await killStaleFfmpeg(pidDir, silentLogger, async (pid) => {
      asked.push(pid);
      return pid === stale.pid;
    });

    assert.deepEqual(killed, [stale.pid]);
    assert.equal(await stale.ended, 'SIGKILL');
    assert.equal(process.kill(recycled.pid, 0), true, 'a pid that is not ffmpeg is never killed');
    assert.deepEqual(asked.sort(), [stale.pid, recycled.pid].sort(), 'garbage is not looked up');
    assert.deepEqual(await readdir(pidDir), ['notes.txt']);
  });

  it('creates the pid directory on first boot', async () => {
    assert.deepEqual(await killStaleFfmpeg(pidDir, silentLogger, async () => true), []);
    assert.deepEqual(await readdir(pidDir), []);
  });
});
