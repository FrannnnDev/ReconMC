import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { runMigrations } from './db/migrate.js';
import { taskRoutes } from './routes/tasks.js';
import { serverRoutes } from './routes/servers.js';
import { queueRoutes } from './routes/queue.js';
import { accountRoutes } from './routes/accounts.js';
import { proxyRoutes } from './routes/proxies.js';
import { agentRoutes } from './routes/agents.js';
import { logger } from './logger.js';
import { requireApiKey, isAuthDisabled } from './middleware/auth.js';
import { isRedisAvailable } from './db/redis.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getCorsOrigin(allowedOrigins: string[] | undefined) {
  if (allowedOrigins?.length) {
    // Allow all origins if * is in the list (dev mode)
    if (allowedOrigins.includes('*')) {
      return true;
    }
    return (reqOrigin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
      cb(null, !reqOrigin || allowedOrigins.includes(reqOrigin));
    };
  }
  // Reject all requests if no origins configured (more secure for production)
  return false;
}

export async function createCoordinatorServer(allowedOrigins?: string[]) {
  const fastify = Fastify({ logger: true, trustProxy: true });

  await fastify.register(cors, {
    origin: getCorsOrigin(allowedOrigins),
    credentials: true
  });

  // Register /api/health BEFORE other routes so it stays public (no auth required)
  fastify.get('/api/health', async (_request, reply) => {
    const redisAvailable = isRedisAvailable();
    return reply.send({
      status: 'ok',
      service: 'coordinator',
      redis: redisAvailable ? 'ok' : 'unavailable',
    });
  });

  // Auth status endpoint (public) - lets frontend know if auth is required
  fastify.get('/api/auth/status', async (_request, reply) => {
    return reply.send({ authRequired: !isAuthDisabled() });
  });

  // Register agent routes BEFORE auth (agents need to register without API key)
  // Agent registration is internal (Docker network) so this is safe
  await fastify.register(agentRoutes, { prefix: '/api' });

  // Register task routes (public for agents, GET logs are protected internally)
  await fastify.register(taskRoutes, { prefix: '/api' });

  // Register queue routes (public for agents)
  await fastify.register(queueRoutes, { prefix: '/api' });

  // Register protected routes (require API key)
  await fastify.register(async function (fastify) {
    fastify.addHook('onRequest', requireApiKey);
    await fastify.register(serverRoutes, { prefix: '/api' });
    await fastify.register(accountRoutes, { prefix: '/api' });
    await fastify.register(proxyRoutes, { prefix: '/api' });
  });

  // Serve dashboard static files from dashboard/dist
  const dashboardDist = path.join(__dirname, '../../dashboard/dist');
  if (existsSync(dashboardDist)) {
    await fastify.register(fastifyStatic, {
      root: dashboardDist,
      prefix: '/',
      wildcard: false,
    });

    // Serve index.html for all non-API routes (SPA support)
    fastify.setNotFoundHandler((request, reply) => {
      if (!request.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'Not Found', message: 'Route not found' });
    });

    logger.info(`Dashboard static files served from ${dashboardDist}`);
  } else {
    logger.warn('Dashboard dist folder not found, serving API only');
  }

  // Sanitize error messages - don't expose raw errors in production
  fastify.setErrorHandler((error, _request, reply) => {
    fastify.log.error(error);
    const isProduction = process.env.NODE_ENV === 'production';
    reply.code(500).send({
      error: 'Internal Server Error',
      message: isProduction ? 'An error occurred' : String(error)
    });
  });

  return fastify;
}

export async function startCoordinatorServer(
  port: number,
  host: string,
  allowedOrigins?: string[]
): Promise<void> {
  await runMigrations();
  const server = await createCoordinatorServer(allowedOrigins);
  await server.listen({ port, host });
  logger.info(`Coordinator listening on http://${host}:${port}`);
}
