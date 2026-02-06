import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import {
  claimFromQueue,
  completeScan,
  failScan,
  getQueueStatus,
  getQueueEntries,
} from '../services/scanQueueManager.js';

export async function queueRoutes(fastify: FastifyInstance) {
  const db = createDb();

  /**
   * GET /api/queue
   * Get queue status (pending/processing counts)
   */
  fastify.get('/queue', async (_request, reply) => {
    try {
      const status = await getQueueStatus(db);
      return reply.send(status);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to get queue status', message: String(err) });
    }
  });

  /**
   * GET /api/queue/entries
   * Get queue entries with optional status filter (pending/processing/completed/failed/all)
   */
  fastify.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>(
    '/queue/entries',
    async (request, reply) => {
      const { status = 'all', limit = '100', offset = '0' } = request.query;
      const validStatuses = ['pending', 'processing', 'completed', 'failed', 'all'];

      if (!validStatuses.includes(status)) {
        return reply.code(400).send({ error: 'Invalid status filter' });
      }

      try {
        const entries = await getQueueEntries(db, {
          status: status as 'pending' | 'processing' | 'completed' | 'failed' | 'all',
          limit: parseInt(limit, 10),
          offset: parseInt(offset, 10),
        });
        return reply.send(entries);
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to get queue entries', message: String(err) });
      }
    }
  );

  /**
   * POST /api/queue/claim
   * Agent claims next server from queue
   * Replaces /api/tasks/claim
   */
  fastify.post<{ Body: { agentId: string } }>(
    '/queue/claim',
    async (request, reply) => {
      const { agentId } = request.body ?? {};
      if (!agentId || typeof agentId !== 'string') {
        return reply.code(400).send({ error: 'agentId is required' });
      }

      try {
        const claimed = await claimFromQueue(db, agentId);
        if (!claimed) {
          return reply.code(204).send();
        }
        return reply.send(claimed);
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to claim queue item', message: String(err) });
      }
    }
  );

  /**
   * POST /api/queue/:id/complete
   * Complete a scan, update history, remove from queue
   * Replaces /api/tasks/:id/complete
   */
  fastify.post<{ Params: { id: string }; Body: { result?: unknown } }>(
    '/queue/:id/complete',
    async (request, reply) => {
      const { result } = request.body ?? {};

      try {
        await completeScan(db, request.params.id, result);
        return reply.send({ message: 'Scan completed successfully' });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to complete scan', message: String(err) });
      }
    }
  );

  /**
   * POST /api/queue/:id/fail
   * Fail a scan, remove from queue with cleanup
   * Replaces /api/tasks/:id/fail
   */
  fastify.post<{ Params: { id: string }; Body: { errorMessage?: string } }>(
    '/queue/:id/fail',
    async (request, reply) => {
      const { errorMessage = 'Scan failed' } = request.body ?? {};

      try {
        await failScan(db, request.params.id, errorMessage);
        return reply.send({ message: 'Scan failed and removed from queue' });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to fail scan', message: String(err) });
      }
    }
  );
}
