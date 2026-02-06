import { Redis, type RedisOptions } from 'ioredis';
import { logger } from '../logger.js';

type RedisType = Redis;

// Redis client singleton
let redisClient: RedisType | null = null;
let redisDisabled = false;

// Default Redis URL for Docker Compose setup
const defaultRedisUrl = 'redis://redis:6379';
const redisUrl = process.env.REDIS_URL || defaultRedisUrl;

/**
 * Key namespace prefixes for Redis
 */
export const REDIS_KEYS = {
  AGENTS_ONLINE: 'reconmc:agents:online',
  AGENT_HEARTBEAT: (id: string) => `reconmc:agent:${id}:heartbeat`,
  AGENT_DATA: (id: string) => `reconmc:agent:${id}:data`,
  QUEUE_PENDING: 'reconmc:queue:pending',
  QUEUE_PROCESSING: 'reconmc:queue:processing',
  QUEUE_ITEM: (id: string) => `reconmc:queue:item:${id}`,
  QUEUE_DUPLICATES: 'reconmc:queue:duplicates',
} as const;

/**
 * Get or create the Redis client singleton
 * Returns null if Redis is disabled or connection failed
 */
export function getRedisClient(): RedisType | null {
  // Return null if Redis is disabled (fallback to PostgreSQL)
  if (redisDisabled) {
    return null;
  }

  // Return existing client if already connected
  if (redisClient && redisClient.status === 'ready') {
    return redisClient;
  }

  // Don't try to connect if URL is empty (explicitly disabled)
  if (!redisUrl || redisUrl.trim() === '') {
    redisDisabled = true;
    logger.info('Redis URL not set, using PostgreSQL-only mode');
    return null;
  }

  try {
    // Create new client
    const client: RedisType = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      reconnectOnError: (err: Error) => {
        // Reconnect on network errors, but not on auth errors
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
          return true;
        }
        return false;
      },
      // Graceful degradation - don't crash on Redis errors
      enableOfflineQueue: false,
    } as RedisOptions);

    // Handle connection events
    client.on('connect', () => {
      logger.info('Redis connecting...');
    });

    client.on('ready', () => {
      logger.info('Redis connected and ready');
      redisDisabled = false;
    });

    client.on('error', (err: Error) => {
      logger.warn(`Redis error: ${err.message}`);
      // Don't disable Redis on transient errors
    });

    client.on('close', () => {
      logger.warn('Redis connection closed');
    });

    redisClient = client;
    return client;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to create Redis client: ${message}. Using PostgreSQL-only mode.`);
    redisDisabled = true;
    return null;
  }
}

/**
 * Check if Redis is available and connected
 */
export function isRedisAvailable(): boolean {
  const client = getRedisClient();
  return client !== null && client.status === 'ready';
}

/**
 * Gracefully close Redis connection
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
      logger.info('Redis connection closed gracefully');
    } catch (err) {
      logger.warn(`Error closing Redis connection: ${err}`);
    }
    redisClient = null;
  }
}

/**
 * Execute a Redis command with fallback handling
 * Returns null if Redis is unavailable
 */
export async function safeRedisCommand<T>(
  command: (client: RedisType) => T | Promise<T>,
  fallbackValue?: T
): Promise<T | null> {
  const client = getRedisClient();
  if (!client || client.status !== 'ready') {
    return fallbackValue ?? null;
  }

  try {
    return await command(client);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Redis command failed: ${message}`);
    return fallbackValue ?? null;
  }
}
