import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { agents } from '../db/schema.js';
import type { NewAgent } from '../db/schema.js';
import {
  getRedisClient,
  isRedisAvailable,
  safeRedisCommand,
  REDIS_KEYS,
} from '../db/redis.js';

const HEARTBEAT_TIMEOUT_MS = 60_000;
const AGENT_TTL_SECONDS = 70; // Slightly longer than heartbeat timeout for safety

/**
 * Validate agent ID format (prevent injection attacks)
 * Only allows alphanumeric characters, dashes, and underscores
 */
export function isValidAgentId(agentId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(agentId) && agentId.length >= 1 && agentId.length <= 100;
}

/**
 * Extract agent number from agent ID (e.g., "agent-1" → 1, "agent-2" → 2)
 */
function getAgentNumberFromId(agentId: string): number {
  const match = agentId.match(/^agent-(\d+)$/);
  if (match) {
    return parseInt(match[1]!, 10);
  }
  // For non-standard IDs, generate a hash-based number
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    const char = agentId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash) % 1000 + 1;
}

/**
 * Register an agent with Redis online set and PostgreSQL
 */
export async function registerAgent(
  db: Db,
  agentId: string,
  options?: { name?: string }
): Promise<{ ok: true; agentId: string; agentName: string }> {
  // Validate agent ID format
  if (!isValidAgentId(agentId)) {
    throw new Error('Invalid agentId format');
  }

  const agentName = options?.name || `Agent ${getAgentNumberFromId(agentId)}`;

  // Insert/update in PostgreSQL (persistent storage)
  await db
    .insert(agents)
    .values({
      id: agentId,
      name: agentName,
      status: 'idle',
    } as NewAgent)
    .onConflictDoUpdate({
      target: agents.id,
      set: {
        name: agentName,
        status: 'idle',
        lastHeartbeat: new Date(),
        currentQueueId: null,
      },
    });

  // Add to Redis online set with TTL (fast online tracking)
  await safeRedisCommand(async (client) => {
    const pipeline = client.pipeline();
    // Add to online agents set
    pipeline.sadd(REDIS_KEYS.AGENTS_ONLINE, agentId);
    // Set heartbeat with TTL
    pipeline.setex(REDIS_KEYS.AGENT_HEARTBEAT(agentId), AGENT_TTL_SECONDS, Date.now().toString());
    // Store agent data for quick lookups
    pipeline.hset(REDIS_KEYS.AGENT_DATA(agentId), {
      id: agentId,
      name: agentName,
      status: 'idle',
      registeredAt: new Date().toISOString(),
    });
    pipeline.expire(REDIS_KEYS.AGENT_DATA(agentId), AGENT_TTL_SECONDS);
    await pipeline.exec();
  });

  return { ok: true, agentId, agentName };
}

/**
 * Update agent heartbeat - extends TTL in Redis, updates PostgreSQL
 */
export async function updateHeartbeat(
  db: Db,
  agentId: string,
  options?: { status?: string; currentQueueId?: string }
): Promise<void> {
  // Validate agent ID format
  if (!isValidAgentId(agentId)) {
    throw new Error('Invalid agentId format');
  }

  // Check if agent exists in PostgreSQL
  const [existing] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!existing) {
    throw new Error('Agent not registered');
  }

  // Update PostgreSQL
  await db
    .update(agents)
    .set({
      lastHeartbeat: new Date(),
      ...(options?.status && { status: options.status }),
      ...(options?.currentQueueId !== undefined && { currentQueueId: options.currentQueueId }),
    })
    .where(eq(agents.id, agentId));

  // Extend TTL in Redis
  await safeRedisCommand(async (client) => {
    const pipeline = client.pipeline();
    // Refresh heartbeat TTL
    pipeline.setex(REDIS_KEYS.AGENT_HEARTBEAT(agentId), AGENT_TTL_SECONDS, Date.now().toString());
    // Always refresh agent data TTL to prevent expiration
    pipeline.expire(REDIS_KEYS.AGENT_DATA(agentId), AGENT_TTL_SECONDS);
    // Update status in agent data if provided
    if (options?.status) {
      pipeline.hset(REDIS_KEYS.AGENT_DATA(agentId), 'status', options.status);
    }
    // Ensure still in online set
    pipeline.sadd(REDIS_KEYS.AGENTS_ONLINE, agentId);
    await pipeline.exec();
  });
}

/**
 * List online agents - from Redis if available, fallback to PostgreSQL
 */
export async function listOnlineAgents(db: Db): Promise<Array<typeof agents.$inferSelect & { offline: boolean }>> {
  const now = Date.now();
  const heartbeatThreshold = now - HEARTBEAT_TIMEOUT_MS;

  // Check if Redis has any online agents
  const onlineAgentIds = await safeRedisCommand<string[]>(async (client) => {
    const ids = await client.smembers(REDIS_KEYS.AGENTS_ONLINE);
    return ids;
  });

  // If Redis has online agents, query PostgreSQL for complete data
  // (Redis is used as a fast filter, PostgreSQL provides full details)
  if (onlineAgentIds && onlineAgentIds.length > 0) {
    const validIds = onlineAgentIds.filter((id) => id && id.length > 0);
    if (validIds.length > 0) {
      // Get full agent data from PostgreSQL
      const list = await db.select().from(agents);
      // Mark agents as online/offline based on Redis set
      return list.map((a) => ({
        ...a,
        offline: !validIds.includes(a.id),
      }));
    }
  }

  // Fallback to PostgreSQL with cleanup
  await removeOfflineAgents(db);
  const list = await db.select().from(agents);
  return list.map((a) => ({
    ...a,
    offline: now - new Date(a.lastHeartbeat).getTime() > HEARTBEAT_TIMEOUT_MS,
  }));
}

/**
 * Remove an agent from Redis and PostgreSQL
 */
export async function removeAgent(db: Db, agentId: string): Promise<boolean> {
  // Validate agent ID format
  if (!isValidAgentId(agentId)) {
    return false;
  }

  // Remove from Redis
  await safeRedisCommand(async (client) => {
    const pipeline = client.pipeline();
    pipeline.srem(REDIS_KEYS.AGENTS_ONLINE, agentId);
    pipeline.del(REDIS_KEYS.AGENT_HEARTBEAT(agentId));
    pipeline.del(REDIS_KEYS.AGENT_DATA(agentId));
    await pipeline.exec();
  });

  // Remove from PostgreSQL (optional - agents are ephemeral, usually TTL handles cleanup)
  // We keep the record in PostgreSQL for history
  return true;
}

/**
 * Remove offline agents from PostgreSQL (called only when Redis is not available)
 * This function is kept for fallback scenario when Redis is disabled
 */
async function removeOfflineAgents(db: Db): Promise<void> {
  // Skip cleanup if Redis is available (TTL handles it)
  if (isRedisAvailable()) {
    return;
  }

  const threshold = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS);
  await db
    .delete(agents)
    .where(
      sql`${agents.lastHeartbeat} < ${threshold}`
    );
}

/**
 * Get agent count from Redis (fast) or PostgreSQL (fallback)
 */
export async function getOnlineAgentCount(db: Db): Promise<number> {
  const count = await safeRedisCommand<number>(async (client) => {
    return client.scard(REDIS_KEYS.AGENTS_ONLINE);
  });

  if (count !== null) {
    return count;
  }

  // Fallback to PostgreSQL
  await removeOfflineAgents(db);
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agents);
  return result[0]?.count ?? 0;
}
