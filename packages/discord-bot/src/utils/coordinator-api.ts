/**
 * Coordinator API client for communicating with the ReconMC coordinator
 */
import { logger } from '../logger.js';
import type { McStatusData } from './api.js';

export interface CoordinatorServer {
  id: string;
  serverAddress: string;
  hostname: string | null;
  resolvedIp: string | null;
  port: number;
  firstSeenAt: string;
  lastScannedAt: string | null;
  scanCount: number;
  latestResult: CoordinatorScanResult | null;
  scanHistory: Array<{
    timestamp: string;
    result: CoordinatorScanResult | null;
    errorMessage?: string;
  }>;
}

export interface CoordinatorScanResult {
  ping: {
    success: boolean;
    host: string;
    port: number;
    resolvedIp?: string;
    status?: {
      raw: string;
      data?: McStatusData;
      latency: number | null;
    };
    attempts: number;
    timestamp: string;
    serverMode?: 'online' | 'cracked' | 'unknown';
    validatedPlayers?: Array<{ name: string; id: string; originalId?: string }>;
  };
  connection?: {
    success: boolean;
    host: string;
    port: number;
    username: string;
    uuid?: string;
    connectedAt?: string;
    disconnectedAt?: string;
    spawnPosition?: { x: number; y: number; z: number };
    error?: { code: string; message: string; kicked?: boolean; kickReason?: string };
    attempts: number;
    latency?: number;
    accountType?: 'cracked' | 'microsoft';
    serverPlugins?: { plugins: string[]; method: string; antiCheats: string[] };
    serverAuth?: { authRequired: boolean; authType?: string; success: boolean; error?: string };
  };
  serverMode?: 'online' | 'cracked' | 'unknown';
}

export interface AddServersResult {
  added: number;
  skipped: number;
  queued: Array<{
    id: string;
    serverAddress: string;
    resolvedIp: string;
    port: number;
  }>;
}

export interface QueueStatus {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  totalServers: number;
}

export interface CoordinatorHealth {
  status: string;
  uptime: number;
  version?: string;
}

/**
 * Scan result format compatible with the existing Discord embed code
 */
export interface ScanResult {
  success: boolean;
  host: string;
  port: number;
  resolvedIp?: string;
  status?: {
    raw: string;
    data?: McStatusData;
    latency: number | null;
  };
  error?: string;
  attempts: number;
  timestamp: string;
  serverMode?: 'online' | 'cracked' | 'unknown';
  validatedPlayers?: Array<{ name: string; id: string; originalId?: string }>;
}

/**
 * Server plugin detection result
 */
export interface ServerPluginInfo {
  plugins: string[];
  method: 'command_tree' | 'tab_complete' | 'combined' | 'plugins_command' | 'bukkit_plugins_command' | 'none';
  antiCheats: string[];
}

/**
 * Server authentication result (for cracked servers)
 */
export interface ServerAuthInfo {
  /** Whether authentication was required */
  authRequired: boolean;
  /** Type of auth performed (login or register) */
  authType?: 'login' | 'register';
  /** Whether auth was successful */
  success: boolean;
  /** Error if auth failed */
  error?: string;
}

/**
 * Bot connection result
 */
export interface ConnectResult {
  success: boolean;
  host: string;
  port: number;
  username: string;
  uuid?: string;
  connectedAt?: string;
  disconnectedAt?: string;
  spawnPosition?: { x: number; y: number; z: number };
  error?: { code: string; message: string; kicked?: boolean; kickReason?: string };
  attempts: number;
  latency?: number;
  accountType?: 'cracked' | 'microsoft';
  serverPlugins?: ServerPluginInfo;
  serverAuth?: ServerAuthInfo;
}

/**
 * Full scan result with both ping and connection data
 */
export interface FullScanResult {
  ping: ScanResult;
  connection?: ConnectResult;
  serverMode?: 'online' | 'cracked' | 'unknown';
}

export class CoordinatorAPIClient {
  private baseUrl: string;
  private apiKey: string | undefined;
  private readonly POLL_INTERVAL_MS = 2000;
  private readonly MAX_POLL_TIME_MS = 120000; // 2 minutes max

  constructor(baseUrl: string = process.env.COORDINATOR_URL || 'http://localhost:3001') {
    // Remove trailing slash
    // Note: Default is 3001 which is the exposed port from Docker (internal is 3000)
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = process.env.RECONMC_API_KEY;
    logger.debug(`[CoordinatorAPI] Using base URL: ${this.baseUrl}`);
    logger.debug(`[CoordinatorAPI] Authentication ${this.apiKey ? 'enabled' : 'disabled (no API key configured)'}`);
  }

  /**
   * Build headers with API key if configured
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }
    return headers;
  }

  /**
   * Check coordinator health
   */
  async checkHealth(): Promise<CoordinatorHealth> {
    const response = await fetch(`${this.baseUrl}/api/health`, {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
    return response.json() as Promise<CoordinatorHealth>;
  }

  /**
   * Add a server to the scan queue
   * Returns the add servers result with added count and queued items
   */
  async addServerToQueue(host: string, port: number = 25565): Promise<AddServersResult> {
    const server = port !== 25565 ? `${host}:${port}` : host;

    logger.debug(`[CoordinatorAPI] Adding server to queue: ${server}`);

    const response = await fetch(`${this.baseUrl}/api/servers/add`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        servers: [server],
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error((error as { message?: string }).message || `Failed to add server: ${response.status}`);
    }

    const result = await response.json() as AddServersResult;
    logger.debug(`[CoordinatorAPI] Server added to queue: ${result.added} added, ${result.skipped} skipped`);

    return result;
  }

  /**
   * Get queue status
   */
  async getQueueStatus(): Promise<QueueStatus> {
    const response = await fetch(`${this.baseUrl}/api/queue`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get queue status: ${response.status}`);
    }

    return response.json() as Promise<QueueStatus>;
  }

  /**
   * Get server by ID with full scan history
   */
  async getServer(serverId: string): Promise<CoordinatorServer | null> {
    const response = await fetch(`${this.baseUrl}/api/servers/${serverId}`, {
      headers: this.getHeaders(),
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Failed to get server: ${response.status}`);
    }

    return response.json() as Promise<CoordinatorServer>;
  }

  /**
   * Get server by address (hostname:port or hostname)
   * Returns null if server not found
   */
  async getServerByAddress(host: string, port: number = 25565): Promise<CoordinatorServer | null> {
    const serverAddress = port !== 25565 ? `${host}:${port}` : host;
    const response = await fetch(`${this.baseUrl}/api/servers/by-address/${encodeURIComponent(serverAddress)}`, {
      headers: this.getHeaders(),
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Failed to get server by address: ${response.status}`);
    }

    return response.json() as Promise<CoordinatorServer>;
  }

  /**
   * Get servers list
   */
  async getServers(limit: number = 100, offset: number = 0): Promise<CoordinatorServer[]> {
    const response = await fetch(`${this.baseUrl}/api/servers?limit=${limit}&offset=${offset}`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get servers: ${response.status}`);
    }

    return response.json() as Promise<CoordinatorServer[]>;
  }

  /**
   * Convert coordinator scan result to full scan result format (ping + connection)
   */
  private resultToScanResult(result: CoordinatorScanResult | null): FullScanResult {
    if (!result || !result.ping) {
      return {
        ping: {
          success: false,
          host: 'unknown',
          port: 25565,
          error: 'No result available',
          attempts: 1,
          timestamp: new Date().toISOString(),
        },
      };
    }

    const ping = result.ping;
    return {
      ping: {
        success: ping.success,
        host: ping.host,
        port: ping.port,
        resolvedIp: ping.resolvedIp,
        status: ping.status,
        error: ping.success ? undefined : 'Server offline or unreachable',
        attempts: ping.attempts,
        timestamp: ping.timestamp,
        serverMode: ping.serverMode || result.serverMode,
        validatedPlayers: ping.validatedPlayers,
      },
      connection: result.connection ? {
        success: result.connection.success,
        host: result.connection.host,
        port: result.connection.port,
        username: result.connection.username,
        uuid: result.connection.uuid,
        connectedAt: result.connection.connectedAt,
        disconnectedAt: result.connection.disconnectedAt,
        spawnPosition: result.connection.spawnPosition,
        error: result.connection.error,
        attempts: result.connection.attempts,
        latency: result.connection.latency,
        accountType: result.connection.accountType,
        serverPlugins: result.connection.serverPlugins ? {
          plugins: result.connection.serverPlugins.plugins,
          method: result.connection.serverPlugins.method as 'command_tree' | 'tab_complete' | 'combined' | 'plugins_command' | 'bukkit_plugins_command' | 'none',
          antiCheats: result.connection.serverPlugins.antiCheats,
        } : undefined,
        serverAuth: result.connection.serverAuth ? {
          authRequired: result.connection.serverAuth.authRequired,
          authType: result.connection.serverAuth.authType as 'login' | 'register' | undefined,
          success: result.connection.serverAuth.success,
          error: result.connection.serverAuth.error,
        } : undefined,
      } : undefined,
      serverMode: ping.serverMode || result.serverMode,
    };
  }

  /**
   * Scan a server by adding it to the queue and polling for completion
   * Returns a full scan result with both ping and connection data
   */
  async scanServer(host: string, port: number = 25565): Promise<FullScanResult> {
    // Add server to queue
    const addResult = await this.addServerToQueue(host, port);

    if (addResult.queued.length === 0) {
      // Server was not queued (likely a duplicate already pending/processing)
      // Try to find the server in the servers list
      const server = port !== 25565 ? `${host}:${port}` : host;
      throw new Error(`Server already in queue: ${server}`);
    }

    // Poll for completion
    return await this.waitForScanCompletion(host, port);
  }

  /**
   * Wait for server scan completion and return the full scan result
   */
  private async waitForScanCompletion(host: string, port: number): Promise<FullScanResult> {
    const startTime = Date.now();
    const serverAddress = port !== 25565 ? `${host}:${port}` : host;

    while (Date.now() - startTime < this.MAX_POLL_TIME_MS) {
      // Try to get the server directly by address
      const server = await this.getServerByAddress(host, port);

      if (server && server.lastScannedAt && server.latestResult) {
        // Server has been scanned and has a result
        const scannedTime = new Date(server.lastScannedAt).getTime();
        const addedTime = startTime;

        // Only return if scanned after we added it
        if (scannedTime >= addedTime - 1000) { // -1000 to account for clock skew
          logger.debug(`[CoordinatorAPI] Server scan complete: ${serverAddress}`);
          return this.resultToScanResult(server.latestResult);
        }
      }

      // Check if still in queue
      const queueStatus = await this.getQueueStatus();
      if (queueStatus.pending === 0 && queueStatus.processing === 0) {
        // Queue is empty, do one final check for the server
        const finalServer = await this.getServerByAddress(host, port);
        if (finalServer && finalServer.lastScannedAt && finalServer.latestResult) {
          logger.debug(`[CoordinatorAPI] Server scan found in final check: ${serverAddress}`);
          return this.resultToScanResult(finalServer.latestResult);
        }
        throw new Error('Scan completed but result not found');
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, this.POLL_INTERVAL_MS));
    }

    throw new Error('Scan timed out after 2 minutes');
  }
}
