import * as net from 'node:net';
import * as dns from 'node:dns';
import { SocksClient } from 'socks';
import type { ScanOptions, ScanResult, Packet, ProxyConfig, ServerStatus, ServerStatusData } from './types.js';
import * as packetGen from './protocol/generator.js';
import * as packetDec from './protocol/decoder.js';
import { lookupSRV } from './srv.js';
import { withRetry } from './retry.js';
import { detectServerMode, detectServerModeSync } from './uuid.js';
import { logger } from './logger.js';
import { z } from 'zod';

/**
 * HTML escape map for XSS prevention
 */
const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
};

/**
 * Escape HTML entities in a string to prevent XSS
 * Applied to all untrusted text content before storage
 */
function escapeHtml(unsafe: unknown): string {
  if (typeof unsafe !== 'string') {
    return String(unsafe ?? '');
  }
  return unsafe.replace(/[&<>"'/]/g, (char) => HTML_ESCAPE_MAP[char]);
}

/**
 * Recursively sanitize all string values in an object
 * - Escapes HTML entities in strings
 * - Preserves numbers, booleans, null
 * - Handles nested objects and arrays
 * - Used for Minecraft text components (description, player names, etc.)
 */
function sanitizeObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return escapeHtml(obj);
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      // Sanitize the key too (though less likely to be exploited)
      const sanitizedKey = escapeHtml(key);
      sanitized[sanitizedKey] = sanitizeObject(value);
    }
    return sanitized;
  }

  return obj;
}

/**
 * Maximum size for JSON responses from untrusted servers (100KB)
 * Prevents DoS via oversized payloads
 */
const MAX_JSON_SIZE = 1024 * 100;

/**
 * Maximum nesting depth for JSON responses (prevents stack overflow)
 */
const MAX_JSON_DEPTH = 32;

/**
 * Check JSON object depth to prevent stack overflow attacks
 */
export function getJsonDepth(value: unknown, currentDepth = 0): number {
  if (currentDepth > MAX_JSON_DEPTH) {
    return currentDepth;
  }
  if (!value || typeof value !== 'object') {
    return currentDepth;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return currentDepth + 1;
    return Math.max(...value.map(v => getJsonDepth(v, currentDepth + 1)));
  }
  const vals = Object.values(value as Record<string, unknown>);
  if (vals.length === 0) return currentDepth + 1;
  return Math.max(...vals.map(v => getJsonDepth(v, currentDepth + 1)));
}

/**
 * Schema for validating Minecraft server status responses
 * Limits string lengths, validates data types, and prevents malicious payloads
 * Uses .passthrough() to allow additional properties (like modinfo, etc.)
 */
const MinecraftStatusSchema = z.object({
  version: z.object({
    name: z.string().max(200),
    protocol: z.number().int().min(0).max(9999),
  }).optional(),
  players: z.object({
    max: z.number().int().min(0).max(1000000),
    online: z.number().int().min(0).max(1000000),
    sample: z.array(z.object({
      name: z.string().max(100),
      id: z.string().max(64).regex(/^[0-9a-fA-F-]+$/, 'Invalid UUID format'),
    })).max(1000).optional(),
  }).optional(),
  description: z.any().optional(), // Minecraft text component - arbitrary JSON allowed
  favicon: z.string().max(1000000).optional(), // Base64 favicon data
  // Allow additional properties (modinfo, etc.)
}).passthrough();

/**
 * Safely parse JSON from untrusted sources
 * - Enforces size limit (100KB)
 * - Limits nesting depth (prevents stack overflow)
 * - Validates string lengths and number ranges via Zod
 * - Sanitizes all text content to prevent XSS (MOTD, player names, plugin names, etc.)
 * - Returns null for invalid/malicious data
 */
function safeJsonParse(data: string): ServerStatusData | null {
  // Size check - reject oversized payloads
  if (data.length > MAX_JSON_SIZE) {
    logger.warn(`[MC-Scanner] Rejected oversized JSON response: ${data.length} bytes`);
    return null;
  }

  try {
    const parsed = JSON.parse(data) as unknown;

    // Depth check - prevent deeply nested objects
    if (getJsonDepth(parsed) > MAX_JSON_DEPTH) {
      logger.warn(`[MC-Scanner] Rejected deeply nested JSON response`);
      return null;
    }

    // Validate against schema (limits string lengths, validates data types)
    const validated = MinecraftStatusSchema.safeParse(parsed);
    if (!validated.success) {
      // Don't log - this is common for non-standard or buggy servers
      return null;
    }

    // Sanitize all string content to prevent XSS attacks
    // This includes: MOTD/description, player names, plugin names, server version, etc.
    const sanitized = sanitizeObject(validated.data) as ServerStatusData;

    return sanitized;
  } catch {
    logger.warn('[MC-Scanner] Failed to parse JSON response');
    return null;
  }
}

/**
 * Custom DNS lookup function for better compatibility
 * Handles both string address and LookupAddress object return types
 */
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

/**
 * SOCKS proxy type for SocksClient
 */
type SocksProxyType = 4 | 5;

const customLookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback
): void => {
  dns.lookup(hostname, options, (err, address, family) => {
    // Handle both string address and LookupAddress cases
    if (typeof address === 'string') {
      callback(err, address, family);
    } else if (address && typeof address === 'object' && 'address' in address && !Array.isArray(address)) {
      // LookupAddress object - extract the address string
      const lookupAddr = address as dns.LookupAddress;
      callback(err, lookupAddr.address, typeof family === 'number' ? family : 4);
    } else if (Array.isArray(address) && address.length > 0) {
      // Multiple addresses - use the first one
      const first = address[0];
      if (typeof first === 'string') {
        callback(err, first, 4);
      } else if (first && typeof first === 'object' && 'address' in first && !Array.isArray(first)) {
        const lookupAddr = first as dns.LookupAddress;
        callback(err, lookupAddr.address, 4);
      } else {
        callback(err ?? new Error('Invalid DNS lookup result'), '', 4);
      }
    } else {
      // Fallback
      callback(err ?? new Error('Invalid DNS lookup result'), '', 4);
    }
  });
};

/**
 * Internal scan options with all defaults applied
 */
interface InternalScanOptions {
  host: string;
  port: number;
  timeout: number;
  retries: number;
  retryDelay: number;
  protocolVersion: number;
  ping: boolean;
  SRVLookup: boolean;
  proxy?: ProxyConfig;
}

export class MinecraftScanner {
  private options: InternalScanOptions;
  private debug: boolean;
  private resolvedIp?: string;

  constructor(options: ScanOptions) {
    // Apply all defaults
    this.options = {
      host: options.host,
      port: options.port ?? 25565,
      timeout: options.timeout ?? 5000,
      retries: options.retries ?? 3,
      retryDelay: options.retryDelay ?? 1000,
      protocolVersion: options.protocolVersion ?? 769,
      ping: options.ping ?? true,
      SRVLookup: options.proxy ? false : (options.SRVLookup ?? true),
      proxy: options.proxy
    };

    // Enable debug logging if MC_DEBUG env var is set
    this.debug = process.env.MC_DEBUG === 'true';

    // Validate port
    if (this.options.port < 1 || this.options.port > 65535) {
      throw new Error('Port number must be between 1 and 65535');
    }

    if (this.options.proxy) {
      logger.debug(`[MC-Scanner] Using ${this.options.proxy.type.toUpperCase()} proxy: ${this.options.proxy.host}:${this.options.proxy.port}`);
    }
  }

  private log(message: string, data?: unknown, alwaysLog: boolean = false) {
    // Always log if alwaysLog is true or debug mode is enabled
    if (alwaysLog || this.debug) {
      if (data !== undefined) {
        logger.debug(`[MC-Scanner] ${message}`, data);
      } else {
        logger.debug(`[MC-Scanner] ${message}`);
      }
    }
  }

  private logError(message: string, error?: Error | unknown) {
    // Errors should always be logged
    if (error !== undefined) {
      logger.error(`[MC-Scanner] ${message}`, error);
    } else {
      logger.error(`[MC-Scanner] ${message}`);
    }
  }

  /**
   * Perform the server scan
   */
  async scan(): Promise<ScanResult> {
    const timestamp = new Date().toISOString();

    this.log(`Starting scan for ${this.options.host}:${this.options.port}`, undefined, true);

    try {
      // Perform SRV lookup if enabled (only when not using proxy)
      let host = this.options.host;
      let port = this.options.port;

      if (this.options.SRVLookup) {
        this.log(`Performing SRV lookup for ${host}`);
        const srvResult = await lookupSRV(host, port);
        this.log(`SRV result:`, srvResult);
        host = srvResult.hostname;
        port = srvResult.port;
      }

      // Resolve the server's IP address (separate DNS lookup)
      await this.resolveServerIp(host);

      this.log(`Connecting to ${host}:${port} (timeout: ${this.options.timeout}ms, retries: ${this.options.retries})`, undefined, true);

      // Track retry attempts for logging
      let attempt = 0;
      const startTime = Date.now();

      // Perform scan with retry logic
      const { result, attempts } = await withRetry(
        () => {
          attempt++;
          this.log(`Connection attempt ${attempt}/${this.options.retries + 1}...`, undefined, true);
          return this.performScan(host, port);
        },
        {
          retries: this.options.retries,
          retryDelay: this.options.retryDelay
        }
      );

      const elapsed = Date.now() - startTime;
      this.log(`Scan successful after ${attempts} attempt(s) in ${elapsed}ms`, undefined, true);

      // Detect server mode from player sample (synchronous for speed)
      let serverMode: 'online' | 'cracked' | 'unknown' | undefined;
      if (result.data?.players?.sample) {
        serverMode = detectServerModeSync(result.data.players.sample);
        this.log(`Detected server mode: ${serverMode}`);
      }

      return {
        success: true,
        host,
        port,
        resolvedIp: this.resolvedIp,
        status: result,
        attempts,
        timestamp,
        serverMode,
        validatedPlayers: undefined, // Will be populated by async detection if enabled
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logError(`Scan failed after ${this.options.retries + 1} attempts: ${errorMessage}`);

      return {
        success: false,
        host: this.options.host,
        port: this.options.port,
        resolvedIp: this.resolvedIp,
        error: errorMessage,
        attempts: this.options.retries + 1,
        timestamp
      };
    }
  }

  /**
   * Resolve the server's IP address via DNS lookup
   */
  private async resolveServerIp(hostname: string): Promise<void> {
    // Skip if it's already an IP address
    if (/^(\d+\.){3}\d+$/.test(hostname) || /^[\d:a-f]+$/i.test(hostname)) {
      this.resolvedIp = hostname;
      this.log(`Host is already an IP address: ${hostname}`);
      return;
    }

    try {
      // Use dns.lookup to resolve the hostname
      const lookupResult = await new Promise<string>((resolve, reject) => {
        dns.lookup(hostname, { family: 4 }, (err, address) => {
          if (err) reject(err);
          // address can be a string or LookupAddress object
          else if (typeof address === 'string') resolve(address);
          else if (address && typeof address === 'object' && 'address' in address) resolve((address as dns.LookupAddress).address);
          else reject(new Error('Invalid DNS lookup result'));
        });
      });

      this.resolvedIp = lookupResult;
      this.log(`Resolved ${hostname} to ${lookupResult}`);
    } catch (error) {
      this.log(`DNS resolution failed for ${hostname}:`, error);
      // Don't fail the scan, just skip the resolved IP
    }
  }

  /**
   * Create SOCKS connection options
   */
  private createSocksOptions(destination: { host: string; port: number }): {
    proxy: {
      host: string;
      port: number;
      type: SocksProxyType;
      userId?: string;
      password?: string;
    };
    command: 'connect';
    destination: { host: string; port: number };
  } {
    const proxy = this.options.proxy!;
    return {
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: proxy.type === 'socks5' ? 5 : 4,
        userId: proxy.username,
        password: proxy.password,
      },
      command: 'connect',
      destination: destination,
    };
  }

  /**
   * Perform the actual TCP connection and protocol handshake via SOCKS proxy
   */
  private async performScanProxied(
    host: string,
    port: number
  ): Promise<ServerStatus> {
    this.log(`Creating SOCKS connection to ${host}:${port} via proxy`);

    const options = this.createSocksOptions({ host, port });
    const connectionTimeoutMs = this.options.timeout;
    let socket: net.Socket | null = null;

    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        // Clean up socket if it exists
        if (socket) {
          socket.destroy();
          socket = null;
        }
        reject(new Error(`SOCKS connection timed out after ${connectionTimeoutMs}ms`));
      }, connectionTimeoutMs);
    });

    // Create connection promise with proper error handling
    const connectionPromise = SocksClient.createConnection(options)
      .then((info) => {
        if (!info || !info.socket) {
          throw new Error('SOCKS connection failed: No socket returned from proxy');
        }
        socket = info.socket;
        this.log(`SOCKS connection established to ${host}:${port}`);
        return socket;
      })
      .catch((err) => {
        // Ensure we have a proper Error object
        const error = err instanceof Error
          ? err
          : new Error(typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : String(err) || 'SOCKS connection failed');
        // Clean up socket if it exists
        if (socket) {
          socket.destroy();
          socket = null;
        }
        throw error;
      });

    // Race between connection and timeout
    try {
      socket = await Promise.race([connectionPromise, timeoutPromise]);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logError(`SOCKS connection failed:`, error.message);
      throw error;
    }

    // At this point, socket must be non-null (otherwise we would have thrown above)
    if (!socket) {
      throw new Error('SOCKS connection failed: No socket available');
    }

    // Non-null assertion: we've verified socket is not null above
    const establishedSocket: net.Socket = socket;

    return new Promise((resolve, reject) => {
      this.runScanProtocol(establishedSocket, host, port, resolve, reject);
    });
  }

  /**
   * Run the Minecraft scan protocol on an established socket
   */
  private runScanProtocol(
    socket: net.Socket,
    host: string,
    port: number,
    resolve: (value: ServerStatus) => void,
    reject: (reason?: unknown) => void
  ): void {
    let packet: Packet = {
      status: {
        handshakeBaked: false,
        pingSent: false,
        pingBaked: false,
        pingSentTime: null
      },
      meta: {
        packetInitialized: false,
        metaCrafted: false,
        fieldsCrafted: false,
        packetID: null,
        dataLength: null,
        fullLength: null,
        metaLength: null
      },
      dataBuffer: new Uint8Array(0),
      fieldsBuffer: new Uint8Array(0),
      crafted: {
        data: null,
        latency: null
      },
      error: null
    };

    const timeout = this.options.timeout;

    const timeoutHandle = setTimeout(() => {
      this.log(`Connection timeout after ${timeout}ms`);
      this.log(`Final packet state:`, {
        handshakeBaked: packet.status.handshakeBaked,
        pingSent: packet.status.pingSent,
        pingBaked: packet.status.pingBaked,
        dataBufferLength: packet.dataBuffer.length,
        fieldsBufferLength: packet.fieldsBuffer.length,
        hasCraftedData: !!packet.crafted.data
      });
      socket.destroy();
      reject(new Error(`Connection timed out after ${timeout}ms`));
    }, timeout);

    // Send handshake and status request immediately after connection
    (async () => {
      try {
        const handshake = await packetGen.craftHandshake(
          host,
          port,
          this.options.protocolVersion
        );

        const statusRequest = await packetGen.craftEmptyPacket(0);

        this.log(`Sending handshake packet (${handshake.length} bytes)`, Array.from(handshake).slice(0, 20));
        this.log(`Sending status request packet (${statusRequest.length} bytes)`, Array.from(statusRequest));

        socket.write(handshake);
        socket.write(statusRequest);
      } catch (error) {
        this.log(`Error sending packets:`, error);
        clearTimeout(timeoutHandle);
        socket.destroy();
        reject(error);
      }
    })();

    socket.on('data', async (chunk) => {
      try {
        // Handle both Buffer and string chunk types
        let uint8Chunk: Uint8Array;
        if (Buffer.isBuffer(chunk)) {
          uint8Chunk = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        } else if (typeof chunk === 'string') {
          // String chunks should not happen in binary mode, but handle gracefully
          this.log(`Warning: Received string chunk instead of buffer`);
          uint8Chunk = new Uint8Array(Buffer.from(chunk));
        } else {
          // Unknown type, try to convert
          uint8Chunk = new Uint8Array(chunk);
        }

        this.log(`Received data chunk (${uint8Chunk.length} bytes)`, Array.from(uint8Chunk).slice(0, 20));

        packet = await packetDec.packetPipeline(uint8Chunk, packet);

        this.log(`Packet state after processing:`, {
          handshakeBaked: packet.status.handshakeBaked,
          pingSent: packet.status.pingSent,
          pingBaked: packet.status.pingBaked,
          packetID: packet.meta.packetID,
          dataLength: packet.meta.dataLength,
          craftedData: packet.crafted.data?.length
        });

        if (packet.error) {
          this.log(`Packet error:`, packet.error);
          clearTimeout(timeoutHandle);
          socket.destroy();
          return reject(packet.error);
        }

        // Check if we're done (ping received or handshake done and ping disabled)
        if (packet.status.pingBaked ||
            (packet.status.handshakeBaked && !this.options.ping)) {
          this.log(`Scan complete!`, {
            pingBaked: packet.status.pingBaked,
            handshakeBaked: packet.status.handshakeBaked,
            latency: packet.crafted.latency
          });
          clearTimeout(timeoutHandle);
          socket.destroy();

          // Parse JSON response safely (validates and sanitizes untrusted server data)
          let data = null;
          if (packet.crafted.data) {
            data = safeJsonParse(packet.crafted.data);
            if (data) {
              this.log(`Parsed and validated response data:`, data);
            } else {
              this.log(`Rejected invalid or malicious JSON response`);
            }
          }

          resolve({
            raw: packet.crafted.data || '',
            data,
            latency: packet.crafted.latency
          });
        }

        // Send ping request if handshake is complete
        if (packet.status.handshakeBaked && !packet.status.pingSent && this.options.ping) {
          this.log(`Handshake complete, sending ping request`);
          const pingRequest = await packetGen.craftPingPacket();
          this.log(`Ping packet (${pingRequest.length} bytes)`, Array.from(pingRequest));
          packet.status.pingSentTime = Date.now();
          packet.status.pingSent = true;
          socket.write(pingRequest);
        }
      } catch (error) {
        this.log(`Error in data handler:`, error);
        clearTimeout(timeoutHandle);
        socket.destroy();
        reject(error);
      }
    });

    socket.on('error', (error) => {
      this.log(`Socket error:`, error);
      clearTimeout(timeoutHandle);
      reject(error);
    });

    socket.on('close', () => {
      // Connection closed before completion
      if (!packet.status.handshakeBaked && !packet.status.pingBaked) {
        clearTimeout(timeoutHandle);
        reject(new Error('Connection closed unexpectedly'));
      }
    });
  }

  /**
   * Perform the actual TCP connection and protocol handshake (direct connection)
   */
  private async performScanDirect(
    host: string,
    port: number
  ): Promise<ServerStatus> {
    return new Promise((resolve, reject) => {
      this.log(`Creating direct socket connection to ${host}:${port}`);

      const socket = net.createConnection(
        {
          host,
          port,
          timeout: this.options.timeout,
          lookup: customLookup
        }
      );

      socket.on('connect', async () => {
        this.log(`Socket connected to ${host}:${port}`);
        // Use the shared protocol handler
        this.runScanProtocol(socket, host, port, resolve, reject);
      });

      socket.on('error', (error) => {
        this.logError(`Socket error:`, error);
        reject(error);
      });
    });
  }

  /**
   * Perform the actual scan - routes to proxied or direct connection
   */
  private async performScan(
    host: string,
    port: number
  ): Promise<ServerStatus> {
    if (this.options.proxy) {
      return this.performScanProxied(host, port);
    } else {
      return this.performScanDirect(host, port);
    }
  }
}

/**
 * Convenience function to scan a Minecraft server
 * Optionally performs async server mode detection if enableServerModeDetection is true
 */
export async function scanServer(options: ScanOptions & { enableServerModeDetection?: boolean }): Promise<ScanResult> {
  const scanner = new MinecraftScanner(options);
  const result = await scanner.scan();

  // If async server mode detection is requested and we have player samples, do async detection
  if (options.enableServerModeDetection && result.success && result.status?.data?.players?.sample) {
    // Store original player sample before validation
    const originalSample = result.status.data.players.sample;
    
    const detection = await detectServerMode(originalSample);
    result.serverMode = detection.serverMode;
    // Store validated players with API-verified UUIDs (for reference)
    result.validatedPlayers = detection.validatedPlayers;
    
    // IMPORTANT: Do NOT replace the original player sample!
    // The server's raw UUIDs should be preserved for display.
    // validatedPlayers is only used for server mode detection.
  }

  return result;
}
