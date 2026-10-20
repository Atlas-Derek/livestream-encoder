import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import { registerRoutes } from './api/routes.ts';
import { ChannelManager } from './channels/manager.ts';
import { LadderSchema } from './channels/schema.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

const ladderPath = path.join(config.rootDir, 'config', 'ladder.json');
const defaultLadder = LadderSchema.parse(JSON.parse(await readFile(ladderPath, 'utf8')));

const manager = new ChannelManager({ config, logger: app.log, defaultLadder });
await manager.init();
registerRoutes(app, manager);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await manager.shutdown();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGINT', (signal) => void shutdown(signal));
process.on('SIGTERM', (signal) => void shutdown(signal));

await app.listen({ host: config.apiHost, port: config.apiPort });
app.log.info(
  { ffmpeg: config.ffmpegPath, encoder: config.videoEncoder, hlsRoot: config.hlsRoot, hls: config.publicHlsBaseUrl },
  'encoder ready',
);
