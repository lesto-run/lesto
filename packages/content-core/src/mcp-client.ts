/**
 * HTTP client for MCP tools to call Studio API.
 *
 * This provides a shared interface for all MCP tools to communicate with
 * the Studio API server, enabling the unified architecture where both
 * Claude Desktop and Studio Chat use the same underlying API.
 */

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

export class McpClient {
  private baseUrl: string;
  private timeout: number;
  private retries: number;
  private debug: boolean;

  constructor(options: McpClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "http://localhost:4400";
    this.timeout = options.timeout ?? 30000;
    this.retries = options.retries ?? 3;
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
        signal: AbortSignal.timeout(2000),
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
    const checkInterval = 500;

    while (Date.now() - startTime < maxWaitMs) {
      if (await this.isStudioRunning()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    return false;
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retriesLeft: number,
  ): Promise<Response> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      // Check for connection refused (Studio not running)
      if (error instanceof Error) {
        const isConnectionError =
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("fetch failed") ||
          error.name === "AbortError";

        if (isConnectionError && retriesLeft > 0) {
          this.log(`Connection failed, retrying (${retriesLeft} left)...`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
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
   * WHY: a retry fires on timeout (AbortError) as well as connection refusal,
   * but a timeout does NOT mean the server never received the request — it may
   * have applied a create/update/delete and simply been slow to respond.
   * Retrying a non-idempotent mutation can double-apply it (duplicate writes,
   * repeated deletes). GET (and HEAD) carry no such risk, so only those retry.
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
   * Yields text chunks as they arrive.
   */
  async *stream(path: string, body: unknown): AsyncGenerator<string, void, unknown> {
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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE format: "data: ...\n\n"
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") {
              return;
            }
            yield data;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// Singleton instance for convenience
let defaultClient: McpClient | null = null;

export function getMcpClient(options?: McpClientOptions): McpClient {
  if (!defaultClient || options) {
    defaultClient = new McpClient(options);
  }
  return defaultClient;
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
