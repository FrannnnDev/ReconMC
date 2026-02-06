import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import {
  registerAgent,
  updateHeartbeat,
  listOnlineAgents,
  removeAgent,
} from '../services/agentService.js';
import { requireApiKey } from '../middleware/auth.js';

export async function agentRoutes(fastify: FastifyInstance) {
  const db = createDb();

  // Agent registration (public - agents are in same Docker network)
  fastify.post<{ Body: { agentId: string; name?: string } }>('/agents/register', async (request, reply) => {
    const agentId = request.body?.agentId;
    if (!agentId || typeof agentId !== 'string') {
      return reply.code(400).send({ error: 'agentId is required' });
    }

    try {
      const result = await registerAgent(db, agentId, { name: request.body?.name });
      return reply.code(200).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Invalid agentId')) {
        return reply.code(400).send({ error: message });
      }
      throw err;
    }
  });

  // Agent heartbeat (public - agents are in same Docker network)
  fastify.post<{ Body: { agentId: string; status?: string; currentQueueId?: string } }>(
    '/agents/heartbeat',
    async (request, reply) => {
      const agentId = request.body?.agentId;
      if (!agentId || typeof agentId !== 'string') {
        return reply.code(400).send({ error: 'agentId is required' });
      }

      try {
        await updateHeartbeat(db, agentId, {
          status: request.body?.status,
          currentQueueId: request.body?.currentQueueId,
        });
        return reply.code(200).send({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('Invalid agentId')) {
          return reply.code(400).send({ error: message });
        }
        if (message.includes('not registered')) {
          return reply.code(404).send({ error: message });
        }
        throw err;
      }
    }
  );

  // List agents (protected - requires API key for external users to view status)
  fastify.get('/agents', { onRequest: requireApiKey }, async (_request, reply) => {
    const list = await listOnlineAgents(db);
    return reply.send(list);
  });

  // Remove an agent (protected - requires API key)
  fastify.delete<{ Params: { id: string } }>('/agents/:id', { onRequest: requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const success = await removeAgent(db, id);
    if (!success) {
      return reply.code(404).send({ error: 'Agent not found' });
    }
    return reply.send({ ok: true });
  });
}
