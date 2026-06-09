import { describe, it, expect, afterEach, vi } from "vitest";
import { McpClient } from "../mcp-client";

/**
 * Regression coverage for the retry policy.
 *
 * A timeout aborts the request with an AbortError, which the client treats as a
 * retryable connection error. For GET that is safe (idempotent). For mutating
 * methods (POST/PUT/DELETE) a retry can double-apply the mutation, because the
 * server may already have processed the first (slow) request. We therefore only
 * retry idempotent methods.
 */
// Every call rejects with an AbortError, mimicking a timed-out request.
function mockTimeoutFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  });
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
    // Exactly one attempt — no retry of the mutation.
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
    await client.get("/api/collections");

    // Initial attempt + 2 retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
