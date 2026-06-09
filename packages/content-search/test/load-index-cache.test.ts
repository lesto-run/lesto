/**
 * Regression: a failed index load must NOT be cached.
 *
 * Before the fix, loadIndex stored the in-flight promise in a 24h-TTL LRU cache
 * and only evicted on a non-ok HTTP response. A thrown fetch (network error) or
 * a rejected promise stayed cached, so a transient failure poisoned every retry
 * for the full TTL. The fix evicts the cache entry whenever the load rejects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadIndex, resetIndexCacheForTests } from "../src/load-index";

const PATH = "/search-index.json";

function okIndexResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      v: 1,
      d: 8,
      m: "test-model",
      b: "2026-06-09T00:00:00.000Z",
      e: [{ i: "a", s: "alpha", c: "docs", t: "Alpha", n: "first" }],
    }),
  } as unknown as Response;
}

describe("loadIndex cache", () => {
  beforeEach(() => {
    resetIndexCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetIndexCacheForTests();
  });

  it("does not serve a rejected load from cache — a retry re-fetches", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      // First load: network error (thrown, not a non-ok response).
      .mockRejectedValueOnce(new Error("network down"))
      // Second load (the retry): succeeds.
      .mockResolvedValueOnce(okIndexResponse());

    vi.stubGlobal("fetch", fetchMock);

    await expect(loadIndex(PATH)).rejects.toThrow("network down");

    // The retry must hit the network again, not replay the cached rejection.
    const index = await loadIndex(PATH);

    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]!.id).toBe("a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a non-ok HTTP response either", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response)
      .mockResolvedValueOnce(okIndexResponse());

    vi.stubGlobal("fetch", fetchMock);

    await expect(loadIndex(PATH)).rejects.toThrow(/503/);

    const index = await loadIndex(PATH);
    expect(index.entries).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches a successful load — a second call dedupes onto one fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okIndexResponse());
    vi.stubGlobal("fetch", fetchMock);

    const first = await loadIndex(PATH);
    const second = await loadIndex(PATH);

    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
