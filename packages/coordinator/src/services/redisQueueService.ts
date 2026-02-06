import { eq, and, or, sql, desc, asc } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { scanQueue, servers, agents } from '../db/schema.js';
import type { NewScanQueue, ScanQueue } from '../db/schema.js';
import { resolveServerIp, PrivateIpError, parseServerAddress } from './ipResolver.js';
import { allocateResourcesTx, releaseResources } from './resourceAllocator.js';
import {
  getRedisClient,
  safeRedisCommand,
  REDIS_KEYS,
} from '../db/redis.js';

export interface AddToQueueInput {
  servers: string[];
}

export interface AddToQueueResult {
  added: number;
  skipped: number;
  queued: Array<{ id: string; serverAddress: string; resolvedIp: string; port: number }>;
}

export interface ClaimedQueueItem {
  queueId: string;
  serverAddress: string;
  port: number;
  proxy: {
    id: string;
    host: string;
    port: number;
    type: 'socks4' | 'socks5';
    username?: string;
    password?: string;
  };
  account: {
    id: string;
    type: string;
    username?: string;
    accessToken?: string;
    refreshToken?: string;
  };
}

export interface QueueStatus {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  totalServers: number;
}

export interface QueueEntryOptions {
  limit?: number;
  offset?: number;
  status?: 'pending' | 'processing' | 'completed' | 'failed' | 'all';
}

/**
 * Generate a unique key for deduplication based on resolvedIp + port + hostname
 */
function getDedupeKey(resolvedIp: string, port: number, hostname: string | null): string {
  return `${resolvedIp}:${port}:${hostname ?? ''}`;
}

/**
 * Parse a server address into hostname and check if port is specified
 */
function parseHostname(serverAddress: string): { hostname: string | null; port: number } {
  const trimmed = serverAddress.trim();
  const [hostPart, portPart] = trimmed.split(':');
  const host = (hostPart ?? trimmed).trim();

  // If the host is an IP address, hostname is null
  const isIp = /^[\d.]+$|^\[?[0-9a-fA-F:]+\]?$/.test(host);
  return {
    hostname: isIp ? null : host,
    port: portPart ? parseInt(portPart, 10) : 25565,
  };
}

/**
 * Add servers to the scan queue with Redis-accelerated duplicate detection
 */
export async function addToQueue(db: Db, input: AddToQueueInput): Promise<AddToQueueResult> {
  const redis = getRedisClient();

  // Resolve all server addresses
  const resolved = await Promise.all(
    input.servers.map(async (addr) => {
      try {
        const trimmed = addr.trim();
        const { hostname, port } = parseHostname(trimmed);
        const { host } = parseServerAddress(trimmed);
        return {
          address: trimmed,
          hostname,
          resolvedIp: await resolveServerIp(host),
          port: Number.isNaN(port) || port <= 0 ? 25565 : Math.min(65535, port),
        };
      } catch (error) {
        // Skip servers that resolve to private IPs (SSRF protection)
        if (error instanceof PrivateIpError) {
          return null;
        }
        throw error;
      }
    })
  );

  // Deduplicate within this batch
  const seenKeys = new Set<string>();
  const uniqueResolved: typeof resolved = [];
  for (const r of resolved) {
    if (!r || !r.address) continue;
    const key = getDedupeKey(r.resolvedIp, r.port, r.hostname);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    uniqueResolved.push(r);
  }

  let skipped = 0;
  const toAdd: typeof uniqueResolved = [];

  // Check for existing duplicates in PostgreSQL
  const existingQueue = await db
    .select({ resolvedIp: scanQueue.resolvedIp, port: scanQueue.port, hostname: scanQueue.hostname })
    .from(scanQueue)
    .where(or(eq(scanQueue.status, 'pending'), eq(scanQueue.status, 'processing')));

  const queueKeys = new Set(
    existingQueue.map((r) => getDedupeKey(r.resolvedIp ?? '', r.port, r.hostname ?? ''))
  );

  for (const r of uniqueResolved) {
    if (!r) continue;
    const key = getDedupeKey(r.resolvedIp, r.port, r.hostname);
    if (queueKeys.has(key)) {
      skipped++;
      continue;
    }
    toAdd.push(r);
  }

  // Add to PostgreSQL
  const added: Array<{ id: string; serverAddress: string; resolvedIp: string; port: number }> = [];

  for (const r of toAdd) {
    if (!r) continue;

    const [inserted] = await db
      .insert(scanQueue)
      .values({
        serverAddress: r.address,
        hostname: r.hostname,
        resolvedIp: r.resolvedIp,
        port: r.port,
        status: 'pending',
      } as NewScanQueue)
      .returning();

    if (inserted) {
      added.push({
        id: inserted.id,
        serverAddress: inserted.serverAddress,
        resolvedIp: inserted.resolvedIp ?? '',
        port: inserted.port,
      });

      // Add to Redis pending queue as a List (not Hash)
      await safeRedisCommand(async (client) => {
        const key = getDedupeKey(r.resolvedIp, r.port, r.hostname);
        const itemData = JSON.stringify({
          id: inserted.id,
          serverAddress: inserted.serverAddress,
          resolvedIp: inserted.resolvedIp,
          port: inserted.port,
          hostname: r.hostname,
        });
        // Push to the end of the list (RPUSH)
        await client.rpush(REDIS_KEYS.QUEUE_PENDING, itemData);
        // Track in duplicates set
        await client.hset(REDIS_KEYS.QUEUE_DUPLICATES, key, inserted.id);
      });
    }
  }

  return { added: added.length, skipped, queued: added };
}

/**
 * Claim next available server from the queue with resource allocation
 * Uses Redis for atomic O(1) operations when available, falls back to PostgreSQL
 */
export async function claimFromQueue(db: Db, agentId: string): Promise<ClaimedQueueItem | null> {
  const redis = getRedisClient();

  if (redis && redis.status === 'ready') {
    return claimFromQueueRedis(db, redis, agentId);
  }

  // Fallback to PostgreSQL
  return claimFromQueuePostgres(db, agentId);
}

/**
 * Fast path: Claim from Redis List with atomic RPOPLPUSH
 */
async function claimFromQueueRedis(
  db: Db,
  redis: ReturnType<typeof getRedisClient>,
  agentId: string
): Promise<ClaimedQueueItem | null> {
  if (!redis) return null;

  // Atomically pop from end of pending and push to processing
  const result = await redis.rpoplpush(REDIS_KEYS.QUEUE_PENDING, REDIS_KEYS.QUEUE_PROCESSING);
  if (!result) return null;

  let itemData: { id: string; serverAddress: string; resolvedIp: string; port: number; hostname: string | null };
  try {
    itemData = JSON.parse(result);
  } catch {
    // Invalid JSON, remove from processing and continue
    await redis.lrem(REDIS_KEYS.QUEUE_PROCESSING, 1, result);
    return null;
  }

  // Store the queue ID in a separate key for reliable cleanup (not reliant on JSON matching)
  await redis.setex(REDIS_KEYS.QUEUE_ITEM(itemData.id), 300, agentId); // 5 min TTL

  try {
    // Use a single transaction for both resource allocation and queue updates
    return await db.transaction(async (tx) => {
      const resources = await allocateResourcesTx(tx);
      if (!resources) {
        // No resources available, put back in pending queue
        await redis.rpoplpush(REDIS_KEYS.QUEUE_PROCESSING, REDIS_KEYS.QUEUE_PENDING);
        await redis.del(REDIS_KEYS.QUEUE_ITEM(itemData.id));
        return null;
      }

      // Update PostgreSQL
      await tx
        .update(scanQueue)
        .set({
          status: 'processing',
          assignedAgentId: agentId,
          assignedProxyId: resources.proxy.id,
          assignedAccountId: resources.account.id,
          startedAt: new Date(),
        })
        .where(eq(scanQueue.id, itemData.id));

      // Update agent status
      await tx
        .update(agents)
        .set({ currentQueueId: itemData.id, status: 'busy' })
        .where(eq(agents.id, agentId));

      const protocol = (resources.proxy.protocol === 'socks4' ? 'socks4' : 'socks5') as 'socks4' | 'socks5';
      return {
        queueId: itemData.id,
        serverAddress: itemData.serverAddress,
        port: itemData.port,
        proxy: {
          id: resources.proxy.id,
          host: resources.proxy.host,
          port: resources.proxy.port,
          type: protocol,
          username: resources.proxy.username ?? undefined,
          password: resources.proxy.password ?? undefined,
        },
        account: {
          id: resources.account.id,
          type: resources.account.type,
          username: resources.account.username ?? undefined,
          accessToken: resources.account.accessToken ?? undefined,
          refreshToken: resources.account.refreshToken ?? undefined,
        },
      };
    });
  } catch (err) {
    // If anything fails, move back to pending and clean up
    await redis.rpoplpush(REDIS_KEYS.QUEUE_PROCESSING, REDIS_KEYS.QUEUE_PENDING);
    await redis.del(REDIS_KEYS.QUEUE_ITEM(itemData.id));
    throw err;
  }
}

/**
 * Fallback: Claim from PostgreSQL with row-level locking
 */
async function claimFromQueuePostgres(db: Db, agentId: string): Promise<ClaimedQueueItem | null> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(scanQueue)
      .where(eq(scanQueue.status, 'pending'))
      .limit(1)
      .for('update', { skipLocked: true });

    if (!item) return null;

    const resources = await allocateResourcesTx(tx);
    if (!resources) return null;

    await tx
      .update(scanQueue)
      .set({
        status: 'processing',
        assignedAgentId: agentId,
        assignedProxyId: resources.proxy.id,
        assignedAccountId: resources.account.id,
        startedAt: new Date(),
      })
      .where(eq(scanQueue.id, item.id));

    // Update agent status and currentQueueId
    await tx
      .update(agents)
      .set({ currentQueueId: item.id, status: 'busy' })
      .where(eq(agents.id, agentId));

    const protocol = (resources.proxy.protocol === 'socks4' ? 'socks4' : 'socks5') as 'socks4' | 'socks5';
    return {
      queueId: item.id,
      serverAddress: item.serverAddress,
      port: item.port,
      proxy: {
        id: resources.proxy.id,
        host: resources.proxy.host,
        port: resources.proxy.port,
        type: protocol,
        username: resources.proxy.username ?? undefined,
        password: resources.proxy.password ?? undefined,
      },
      account: {
        id: resources.account.id,
        type: resources.account.type,
        username: resources.account.username ?? undefined,
        accessToken: resources.account.accessToken ?? undefined,
        refreshToken: resources.account.refreshToken ?? undefined,
      },
    };
  });
}

/**
 * Get current queue status statistics
 * Uses Redis for fast counts when available
 */
export async function getQueueStatus(db: Db): Promise<QueueStatus> {
  const redis = getRedisClient();

  let pending = 0;
  let processing = 0;

  if (redis && redis.status === 'ready') {
    // Clean up orphaned processing items before getting counts
    await cleanupOrphanedProcessingItems(redis, db);

    // Fast path: Get list lengths from Redis
    pending = await redis.llen(REDIS_KEYS.QUEUE_PENDING) || 0;
    processing = await redis.llen(REDIS_KEYS.QUEUE_PROCESSING) || 0;
  } else {
    // Fallback: Query PostgreSQL
    const [pendingResult, processingResult] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(scanQueue).where(eq(scanQueue.status, 'pending')),
      db.select({ count: sql<number>`count(*)::int` }).from(scanQueue).where(eq(scanQueue.status, 'processing')),
    ]);
    pending = pendingResult[0]?.count ?? 0;
    processing = processingResult[0]?.count ?? 0;
  }

  // Completed/failed always come from PostgreSQL (historical data)
  const [completedResult, failedResult, totalServersResult] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(scanQueue).where(eq(scanQueue.status, 'completed')),
    db.select({ count: sql<number>`count(*)::int` }).from(scanQueue).where(eq(scanQueue.status, 'failed')),
    db.select({ count: sql<number>`count(*)::int` }).from(servers),
  ]);

  return {
    pending,
    processing,
    completed: completedResult[0]?.count ?? 0,
    failed: failedResult[0]?.count ?? 0,
    totalServers: totalServersResult[0]?.count ?? 0,
  };
}

/**
 * Clean up orphaned items in the Redis processing list.
 * This handles cases where agents crashed after claiming but before completing.
 * An item is orphaned if it's in Redis processing but not in PostgreSQL processing,
 * or if the tracking key has expired (agent didn't heartbeat).
 */
async function cleanupOrphanedProcessingItems(
  redis: ReturnType<typeof getRedisClient>,
  db: Db
): Promise<void> {
  if (!redis) return;

  try {
    const processingList = await redis.lrange(REDIS_KEYS.QUEUE_PROCESSING, 0, -1);
    if (processingList.length === 0) return;

    // Get all currently processing IDs from PostgreSQL
    const pgProcessing = await db
      .select({ id: scanQueue.id })
      .from(scanQueue)
      .where(eq(scanQueue.status, 'processing'));

    const pgProcessingIds = new Set(pgProcessing.map((item) => item.id));

    for (const itemStr of processingList) {
      try {
        const parsed = JSON.parse(itemStr);
        const itemId = parsed.id;

        // Check if tracking key exists (should exist if actively processing)
        const trackingKey = REDIS_KEYS.QUEUE_ITEM(itemId);
        const trackingExists = await redis.exists(trackingKey);

        // Remove from Redis processing if:
        // 1. Not in PostgreSQL processing anymore, OR
        // 2. Tracking key expired (agent crashed/timeout)
        if (!pgProcessingIds.has(itemId) || trackingExists === 0) {
          await redis.lrem(REDIS_KEYS.QUEUE_PROCESSING, 1, itemStr);
          // Also clean up the tracking key if it exists
          if (trackingExists === 1) {
            await redis.del(trackingKey);
          }
        }
      } catch {
        // Invalid JSON - remove it
        await redis.lrem(REDIS_KEYS.QUEUE_PROCESSING, 1, itemStr);
      }
    }
  } catch (err) {
    // Log but don't fail - cleanup is best-effort
    console.error('Error during Redis processing list cleanup:', err);
  }
}

/**
 * Get scan queue entries with pagination and optional status filter
 */
export async function getQueueEntries(db: Db, options: QueueEntryOptions = {}): Promise<typeof scanQueue.$inferSelect[]> {
  const { limit = 100, offset = 0, status = 'all' } = options;

  const baseQuery = db.select().from(scanQueue);

  const query = status !== 'all'
    ? baseQuery.where(eq(scanQueue.status, status))
    : baseQuery;

  return query
    .orderBy(scanQueue.createdAt)
    .limit(limit)
    .offset(offset);
}

/**
 * Complete a scan - update server history and remove from queue
 */
export async function completeScan(
  db: Db,
  queueId: string,
  result: unknown,
  errorMessage?: string
): Promise<void> {
  const redis = getRedisClient();

  // Get queue item from PostgreSQL
  const [item] = await db.select().from(scanQueue).where(eq(scanQueue.id, queueId)).limit(1);
  if (!item) return;

  // Release resources
  if (item.assignedProxyId && item.assignedAccountId) {
    await releaseResources(db, item.assignedProxyId, item.assignedAccountId);
  }

  // Clear agent's currentQueueId and set status to idle
  if (item.assignedAgentId) {
    await db
      .update(agents)
      .set({ currentQueueId: null, status: 'idle' })
      .where(eq(agents.id, item.assignedAgentId));
  }

  // Build scan history entry
  const historyEntry = {
    timestamp: new Date().toISOString(),
    result: errorMessage ? null : result,
    errorMessage: errorMessage ?? undefined,
  };

  // Update or create server record
  const existingServer = await db
    .select()
    .from(servers)
    .where(
      and(
        eq(servers.resolvedIp, item.resolvedIp ?? ''),
        eq(servers.port, item.port),
        // Handle null hostname comparison
        sql`${servers.hostname} IS NOT DISTINCT FROM ${item.hostname}`
      )
    )
    .limit(1);

  if (existingServer.length > 0) {
    // Update existing server
    const server = existingServer[0]!;
    const currentHistory = (server.scanHistory as unknown as Array<typeof historyEntry>) ?? [];
    const updatedHistory = [historyEntry, ...currentHistory].slice(0, 100); // Keep last 100 scans
    await db
      .update(servers)
      .set({
        lastScannedAt: new Date(),
        scanCount: sql`${servers.scanCount} + 1`,
        latestResult: result ? (result as object) : null,
        scanHistory: updatedHistory as any,
      })
      .where(eq(servers.id, server.id));
  } else {
    // Create new server record
    await db.insert(servers).values({
      serverAddress: item.serverAddress,
      hostname: item.hostname,
      resolvedIp: item.resolvedIp,
      port: item.port,
      firstSeenAt: new Date(),
      lastScannedAt: new Date(),
      scanCount: 1,
      latestResult: result ? (result as object) : null,
      scanHistory: [historyEntry] as any,
    });
  }

  // Mark queue item as completed
  await db
    .update(scanQueue)
    .set({
      status: errorMessage ? 'failed' : 'completed',
      errorMessage: errorMessage ?? null,
      completedAt: new Date(),
    })
    .where(eq(scanQueue.id, queueId));

  // Remove from Redis processing list and duplicates set
  if (redis && redis.status === 'ready') {
    const dedupeKey = getDedupeKey(item.resolvedIp ?? '', item.port, item.hostname);
    await safeRedisCommand(async (client) => {
      // Remove the queue item tracking key
      await client.del(REDIS_KEYS.QUEUE_ITEM(queueId));
      // Remove from duplicates tracking
      await client.hdel(REDIS_KEYS.QUEUE_DUPLICATES, dedupeKey);
      // Remove from processing list by searching for the queue ID in stored items
      // This is O(n) but processing list should be small
      const processingList = await client.lrange(REDIS_KEYS.QUEUE_PROCESSING, 0, -1);
      for (const item of processingList) {
        try {
          const parsed = JSON.parse(item);
          if (parsed.id === queueId) {
            await client.lrem(REDIS_KEYS.QUEUE_PROCESSING, 1, item);
            break;
          }
        } catch {
          // Skip invalid JSON entries
          await client.lrem(REDIS_KEYS.QUEUE_PROCESSING, 1, item);
        }
      }
    });
  }

  // Remove from PostgreSQL queue
  await db.delete(scanQueue).where(eq(scanQueue.id, queueId));
}

/**
 * Fail a scan - remove from queue with cleanup
 */
export async function failScan(db: Db, queueId: string, errorMessage: string): Promise<void> {
  await completeScan(db, queueId, null, errorMessage);
}

/**
 * Get list of all servers with pagination
 */
export async function listServers(db: Db, options: { limit?: number; offset?: number } = {}): Promise<typeof servers.$inferSelect[]> {
  const { limit = 100, offset = 0 } = options;
  return db
    .select()
    .from(servers)
    .orderBy(desc(servers.lastScannedAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Get server by ID with full scan history
 */
export async function getServer(db: Db, serverId: string): Promise<typeof servers.$inferSelect | null> {
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  return server ?? null;
}

/**
 * Delete a server record
 */
export async function deleteServer(db: Db, serverId: string): Promise<boolean> {
  const result = await db.delete(servers).where(eq(servers.id, serverId)).returning();
  return result.length > 0;
}
