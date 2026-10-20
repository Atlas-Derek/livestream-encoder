import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ChannelManager } from '../channels/manager.ts';
import { ChannelSpecSchema } from '../channels/schema.ts';
import { AppError } from '../errors.ts';

const IdParamsSchema = z.object({ id: z.string() });

function parseId(params: unknown): string {
  return IdParamsSchema.parse(params).id;
}

export function registerRoutes(app: FastifyInstance, manager: ChannelManager): void {
  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500) request.log.error({ err }, err.message);
      return reply.status(err.status).send({ error: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: 'invalid request', issues: err.issues });
    }
    // Fastify's own errors (bad JSON, wrong content type) carry a 4xx statusCode.
    const statusCode = err instanceof Error && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (statusCode >= 500) request.log.error({ err }, 'unhandled error');
    return reply.status(statusCode).send({ error: err instanceof Error ? err.message : 'internal error' });
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/channels', async () => manager.list());

  app.post('/channels', async (request, reply) => {
    const spec = ChannelSpecSchema.parse(request.body);
    const status = await manager.create(spec);
    return reply.status(201).send(status);
  });

  app.get('/channels/:id', async (request) => manager.get(parseId(request.params)));

  app.post('/channels/:id/start', async (request) => manager.start(parseId(request.params)));

  app.post('/channels/:id/stop', async (request) => manager.stop(parseId(request.params)));

  app.delete('/channels/:id', async (request, reply) => {
    await manager.remove(parseId(request.params));
    return reply.status(204).send();
  });
}
