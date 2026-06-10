/**
 * HTTP client for MCP tools to call Studio API.
 *
 * This provides a shared interface for all MCP tools to communicate with
 * the Studio API server, enabling the unified architecture where both
 * Claude Desktop and Studio Chat use the same underlying API.
 */

// Constants for timeouts and polling intervals
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 3;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const STUDIO_POLL_INTERVAL_MS = 500;
const RETRY_DELAY_MS = 1000;

export interface McpClientOptions {
  /** Base URL of the Studio API (default: http://localhost:4400) */
  baseUrl?: string | undefined;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number | undefined;
  /** Number of retry attempts for connection errors (default: 3) */
  retries?: number | undefined;
  /** Enable debug logging */
  debug?: boolean | undefined;
}

export interface McpClientResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T | undefined;
  error?: string | undefined;
}

export class StudioNotRunningError extends Error {
  constructor() {
    super("Studio API is not running. Start it with: docks studio");
    this.name = "StudioNotRunningError";
  }
}

/**
 * SSE event structure returned from streaming.
 */
export interface SseEvent {
  /** Event type (optional, defaults to "message") */
  event?: string | undefined;
  /** Event data */
  data: string;
}

export class McpClient {
  private baseUrl: string;
  private timeout: number;
  private retries: number;
  private debug: boolean;

  constructor(options: McpClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "http://localhost:4400";
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.debug = options.debug ?? false;
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.error("[MCP Client]", ...args);
    }
  }

  /**
   * Check if Studio is running by hitting the health endpoint.
   */
  async isStudioRunning(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Wait for Studio to be available, with retries.
   */
  async waitForStudio(maxWaitMs = 5000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (await this.isStudioRunning()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, STUDIO_POLL_INTERVAL_MS));
    }

    return false;
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retriesLeft: number,
  ): Promise<Response> {
    // Use AbortSignal.timeout() for cleaner timeout handling
    const timeoutSignal = AbortSignal.timeout(this.timeout);

    // Compose with any existing signal from options
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    try {
      const response = await fetch(url, {
        ...options,
        signal,
      });

      return response;
    } catch (error) {
      // Check for connection refused (Studio not running)
      if (error instanceof Error) {
        const isConnectionError =
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("fetch failed") ||
          error.name === "AbortError" ||
          error.name === "TimeoutError";

        if (isConnectionError && retriesLeft > 0) {
          this.log(`Connection failed, retrying (${retriesLeft} left)...`);
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          return this.fetchWithRetry(url, options, retriesLeft - 1);
        }

        if (isConnectionError) {
          throw new StudioNotRunningError();
        }
      }

      throw error;
    }
  }

  /**
   * Only idempotent HTTP methods may be safely retried.
   *
   * WHY: a retry fires on timeout (AbortError/TimeoutError) as well as
   * connection refusal, but a timeout does NOT mean the server never received
   * the request — it may have applied a create/update/delete and simply been
   * slow to respond. Retrying a non-idempotent mutation can double-apply it
   * (duplicate writes, repeated deletes). GET (and HEAD) carry no such risk, so
   * only those retry.
   */
  private static readonly IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<McpClientResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    this.log(`${method} ${url}`);

    const options: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
      },
    };

    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const retries = McpClient.IDEMPOTENT_METHODS.has(method.toUpperCase()) ? this.retries : 0;

    try {
      const response = await this.fetchWithRetry(url, options, retries);
      const contentType = response.headers.get("content-type");

      let data: T | undefined;
      if (contentType?.includes("application/json")) {
        data = (await response.json()) as T;
      }

      if (!response.ok) {
        const errorData = data as { error?: string } | undefined;
        return {
          ok: false,
          status: response.status,
          error: errorData?.error ?? `HTTP ${response.status}`,
        };
      }

      return {
        ok: true,
        status: response.status,
        data,
      };
    } catch (error) {
      if (error instanceof StudioNotRunningError) {
        return {
          ok: false,
          status: 0,
          error: error.message,
        };
      }

      return {
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * GET request to Studio API.
   */
  async get<T>(path: string): Promise<McpClientResponse<T>> {
    return this.request<T>("GET", path);
  }

  /**
   * POST request to Studio API.
   */
  async post<T>(path: string, body: unknown): Promise<McpClientResponse<T>> {
    return this.request<T>("POST", path, body);
  }

  /**
   * PUT request to Studio API.
   */
  async put<T>(path: string, body: unknown): Promise<McpClientResponse<T>> {
    return this.request<T>("PUT", path, body);
  }

  /**
   * DELETE request to Studio API.
   */
  async delete<T>(path: string): Promise<McpClientResponse<T>> {
    return this.request<T>("DELETE", path);
  }

  /**
   * Stream SSE responses from Studio API (for AI endpoints).
   * Yields SSE events with optional event type and data.
   * Handles SSE format properly including comments, event types, and multi-line data.
   */
  async *stream(path: string, body: unknown): AsyncGenerator<SseEvent, void, unknown> {
    const url = `${this.baseUrl}${path}`;
    this.log(`STREAM ${url}`);

    const response = await this.fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      },
      this.retries,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Stream request failed: ${response.status} ${text}`);
    }

    if (!response.body) {
      throw new Error("No response body for streaming");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent: string | undefined;
    let currentData: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE format line by line
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          // Empty line signals event dispatch
          if (line === "") {
            if (currentData.length > 0) {
              const data = currentData.join("\n");
              if (data === "[DONE]") {
                return;
              }
              yield { event: currentEvent, data };
              currentEvent = undefined;
              currentData = [];
            }
            continue;
          }

          // SSE comment - ignore
          if (line.startsWith(":")) {
            continue;
          }

          // Parse field: value
          const colonIndex = line.indexOf(":");
          if (colonIndex === -1) continue;

          const field = line.slice(0, colonIndex);
          // Value starts after colon, skip optional leading space
          let fieldValue = line.slice(colonIndex + 1);
          if (fieldValue.startsWith(" ")) {
            fieldValue = fieldValue.slice(1);
          }

          switch (field) {
            case "event":
              currentEvent = fieldValue;
              break;
            case "data":
              currentData.push(fieldValue);
              break;
            case "id":
              // Event ID - could be stored for reconnection but not needed here
              break;
            case "retry":
              // Reconnection interval - not needed for our use case
              break;
          }
        }
      }

      // Handle any remaining buffered data
      if (currentData.length > 0) {
        const data = currentData.join("\n");
        if (data !== "[DONE]") {
          yield { event: currentEvent, data };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// Singleton instance for convenience
let defaultClient: McpClient | null = null;

/**
 * Get the default singleton MCP client instance.
 * Creates a new instance if one doesn't exist.
 */
export function getDefaultMcpClient(): McpClient {
  if (!defaultClient) {
    defaultClient = new McpClient();
  }
  return defaultClient;
}

/**
 * Create a new MCP client with custom options.
 * Use this when you need a client with specific configuration.
 */
export function createMcpClient(options: McpClientOptions): McpClient {
  return new McpClient(options);
}

/**
 * Get an MCP client - returns the singleton if no options provided,
 * or creates a new client if options are specified.
 * @deprecated Use getDefaultMcpClient() or createMcpClient() instead for clarity
 */
export function getMcpClient(options?: McpClientOptions): McpClient {
  return options ? createMcpClient(options) : getDefaultMcpClient();
}

// Type definitions for Studio API responses
export interface CollectionInfo {
  name: string;
  entries: Array<{
    slug: string;
    data: Record<string, unknown>;
  }>;
}

export interface CollectionListResponse {
  collections: CollectionInfo[];
}

export interface EntryInfo {
  slug: string;
  collection: string;
  data: Record<string, unknown>;
  content?: string;
  rendered?: string;
  wordCount?: number;
  filePath?: string;
  lastModified?: string;
  rawContent?: string;
  schemaFields?: Array<{
    name: string;
    type: string;
    required: boolean;
  }>;
  isMDX?: boolean;
}

export interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  options?: string[];
}

export interface SchemaResponse {
  fields: SchemaField[];
}

export interface VoiceProfileResponse {
  collection: string;
  sampleCount: number;
  systemPrompt: string;
}

export interface AIStatusResponse {
  configured: boolean;
}
