import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import {
  addToQueue,
  listServers,
  getServer,
  deleteServer,
  type AddToQueueResult,
} from '../services/redisQueueService.js';
import { eq } from 'drizzle-orm';
import { servers } from '../db/schema.js';

export async function serverRoutes(fastify: FastifyInstance) {
  const db = createDb();

  /**
   * POST /api/servers/add
   * Add server(s) to the scan queue
   * Returns { added, skipped, queued[] }
   */
  fastify.post<{ Body: { servers: string[] } }>(
    '/servers/add',
    async (request, reply) => {
      const { servers: serverList } = request.body ?? {};
      if (!Array.isArray(serverList) || serverList.length === 0) {
        return reply.code(400).send({ error: 'servers array is required and must not be empty' });
      }

      try {
        const result = await addToQueue(db, { servers: serverList });
        return reply.code(201).send(result);
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to add servers', message: String(err) });
      }
    }
  );

  /**
   * GET /api/servers
   * List all servers with latest results
   * Query params: limit (default 100), offset (default 0)
   */
  fastify.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/servers',
    async (request, reply) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 100;
      const offset = request.query.offset ? parseInt(request.query.offset, 10) : 0;

      try {
        const serverList = await listServers(db, { limit, offset });
        return reply.send(serverList);
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to list servers', message: String(err) });
      }
    }
  );

  /**
   * GET /api/servers/:id
   * Get server with full scan history
   */
  fastify.get<{ Params: { id: string } }>(
    '/servers/:id',
    async (request, reply) => {
      try {
        const server = await getServer(db, request.params.id);
        if (!server) {
          return reply.code(404).send({ error: 'Server not found' });
        }
        return reply.send(server);
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to get server', message: String(err) });
      }
    }
  );

  /**
   * DELETE /api/servers/:id
   * Delete a server record
   */
  fastify.delete<{ Params: { id: string } }>(
    '/servers/:id',
    async (request, reply) => {
      try {
        const deleted = await deleteServer(db, request.params.id);
        if (!deleted) {
          return reply.code(404).send({ error: 'Server not found' });
        }
        return reply.send({ message: 'Server deleted successfully' });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to delete server', message: String(err) });
      }
    }
  );
}
