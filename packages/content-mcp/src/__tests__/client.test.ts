import { describe, it, expect, afterEach, vi } from "vitest";
import {
  McpClient,
  StudioNotRunningError,
  getDefaultMcpClient,
  createMcpClient,
  getMcpClient,
  type SseEvent,
} from "../client";

/**
 * Tests for the Studio HTTP client.
 *
 * Fix 4 (non-idempotent retry): a timeout aborts the request with an
 * AbortError/TimeoutError, which the client treats as a retryable connection
 * error. For GET/HEAD that is safe (idempotent). For mutating methods
 * (POST/PUT/DELETE) a retry can double-apply the mutation, because the server
 * may already have processed the first (slow) request. We therefore only retry
 * idempotent methods.
 */

// Every call rejects with an AbortError, mimicking a timed-out request.
function mockTimeoutFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name === "content-type" ? "application/json" : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("McpClient retry policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT retry a POST (non-idempotent) on timeout", async () => {
    const fetchMock = mockTimeoutFetch();
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpClient({ timeout: 5, retries: 3 });
    const res = await client.post("/api/entries", { slug: "x" });

    expect(res.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a PUT on timeout", async () => {
    const fetchMock = mockTimeoutFetch();
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpClient({ timeout: 5, retries: 3 });
    await client.put("/api/collections/posts/x", { data: {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a DELETE on timeout", async () => {
    const fetchMock = mockTimeoutFetch();
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpClient({ timeout: 5, retries: 3 });
    await client.delete("/api/collections/posts/x");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("DOES retry a GET (idempotent) on timeout", async () => {
    const fetchMock = mockTimeoutFetch();
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpClient({ timeout: 5, retries: 2 });
    const res = await client.get("/api/collections");

    // Initial attempt + 2 retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Studio API is not running");
  });
});

describe("McpClient request handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed JSON data on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ collections: [] })),
    );
    const client = new McpClient();
    const res = await client.get<{ collections: unknown[] }>("/api/collections");
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ collections: [] });
  });

  it("maps a non-ok JSON response to an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "nope" }, 400)),
    );
    const client = new McpClient();
    const res = await client.post("/api/entries", {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe("nope");
  });

  it("falls back to an HTTP status message when no error field is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 503)),
    );
    const client = new McpClient();
    const res = await client.get("/api/collections");
    expect(res.error).toBe("HTTP 503");
  });

  it("surfaces a non-connection error verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("totally unexpected");
      }),
    );
    const client = new McpClient();
    const res = await client.get("/api/collections");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("totally unexpected");
  });

  it("stringifies a non-Error thrown value (e.g. a thrown string)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // eslint-disable-next-line no-throw-literal
        throw "string failure";
      }),
    );
    const client = new McpClient();
    const res = await client.get("/api/collections");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("string failure");
  });

  it("returns ok with undefined data when the response is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 204,
            headers: { get: () => "text/plain" },
            json: async () => {
              throw new Error("not json");
            },
            text: async () => "",
          }) as unknown as Response,
      ),
    );
    const client = new McpClient();
    const res = await client.get("/api/collections");
    expect(res.ok).toBe(true);
    expect(res.data).toBeUndefined();
  });

  it("logs when debug is enabled", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({})),
    );
    const client = new McpClient({ debug: true });
    await client.get("/api/collections");
    expect(errSpy).toHaveBeenCalledWith("[MCP Client]", expect.stringContaining("GET"));
  });

  it("retries on a connection-refused error before giving up", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new McpClient({ retries: 1 });
    const res = await client.get("/api/collections");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.error).toContain("Studio API is not running");
  });
});

describe("McpClient.isStudioRunning / waitForStudio", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports running when health endpoint is ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true })),
    );
    const client = new McpClient();
    expect(await client.isStudioRunning()).toBe(true);
  });

  it("reports not running when health endpoint throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const client = new McpClient();
    expect(await client.isStudioRunning()).toBe(false);
  });

  it("waitForStudio resolves true as soon as Studio is up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true })),
    );
    const client = new McpClient();
    expect(await client.waitForStudio(1000)).toBe(true);
  });

  it("waitForStudio gives up after the window when Studio never comes up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const client = new McpClient();
    // Window shorter than the 500ms poll interval -> at most one check, then false.
    expect(await client.waitForStudio(1)).toBe(false);
  });
});

function streamResponse(chunks: string[], ok = true, status = 200): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = {
    getReader() {
      return {
        read: async () => {
          if (i < chunks.length) {
            return { done: false, value: encoder.encode(chunks[i++]) };
          }
          return { done: true, value: undefined };
        },
        releaseLock() {},
      };
    },
  };
  return {
    ok,
    status,
    body: ok ? body : null,
    headers: { get: () => "text/event-stream" },
    text: async () => "stream error body",
  } as unknown as Response;
}

describe("McpClient.stream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses event/data fields, comments, and multi-line data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse([
          ": a comment\n",
          "event: chunk\n",
          "data: line one\n",
          "data: line two\n",
          "\n",
          "id: 7\n",
          "retry: 1000\n",
          "data: solo\n",
          "\n",
          "data: [DONE]\n",
          "\n",
        ]),
      ),
    );
    const client = new McpClient();
    const events: SseEvent[] = [];
    for await (const ev of client.stream("/api/ai", {})) {
      events.push(ev);
    }
    expect(events).toEqual([
      { event: "chunk", data: "line one\nline two" },
      { event: undefined, data: "solo" },
    ]);
  });

  it("flushes a trailing event that has no terminating blank line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(["data: trailing\n"])),
    );
    const client = new McpClient();
    const events: SseEvent[] = [];
    for await (const ev of client.stream("/api/ai", {})) {
      events.push(ev);
    }
    expect(events).toEqual([{ event: undefined, data: "trailing" }]);
  });

  it("ignores malformed lines and reads data with no leading space", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse([
          "garbage-with-no-colon\n",
          "data:nospace\n", // colon present but no space after it
          "\n",
          "data: [DONE]\n",
          "\n",
        ]),
      ),
    );
    const client = new McpClient();
    const events: SseEvent[] = [];
    for await (const ev of client.stream("/api/ai", {})) {
      events.push(ev);
    }
    expect(events).toEqual([{ event: undefined, data: "nospace" }]);
  });

  it("dispatches an empty-data blank line without yielding (no buffered data)", async () => {
    // A blank line with nothing buffered must not emit an event.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(["\n", "\n", "data: [DONE]\n", "\n"])),
    );
    const client = new McpClient();
    const events: unknown[] = [];
    for await (const ev of client.stream("/api/ai", {})) {
      events.push(ev);
    }
    expect(events).toEqual([]);
  });

  it("throws when the stream response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse([], false, 500)),
    );
    const client = new McpClient();
    await expect(async () => {
      for await (const _ of client.stream("/api/ai", {})) {
        // drain
      }
    }).rejects.toThrow("Stream request failed");
  });

  it("throws when the ok stream response has no body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            body: null,
            headers: { get: () => "text/event-stream" },
            text: async () => "",
          }) as unknown as Response,
      ),
    );
    const client = new McpClient();
    await expect(async () => {
      for await (const _ of client.stream("/api/ai", {})) {
        // drain
      }
    }).rejects.toThrow("No response body");
  });
});

describe("client factories", () => {
  it("getDefaultMcpClient returns a stable singleton", () => {
    expect(getDefaultMcpClient()).toBe(getDefaultMcpClient());
  });

  it("createMcpClient always returns a fresh instance", () => {
    expect(createMcpClient({ baseUrl: "http://x" })).not.toBe(
      createMcpClient({ baseUrl: "http://x" }),
    );
  });

  it("getMcpClient returns the singleton without options and a fresh client with options", () => {
    expect(getMcpClient()).toBe(getDefaultMcpClient());
    expect(getMcpClient({ baseUrl: "http://y" })).not.toBe(getDefaultMcpClient());
  });

  it("StudioNotRunningError carries the expected name and message", () => {
    const err = new StudioNotRunningError();
    expect(err.name).toBe("StudioNotRunningError");
    expect(err.message).toContain("docks studio");
  });
});
