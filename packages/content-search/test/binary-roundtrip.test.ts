/**
 * Round-trip regression: a binary-only (v3) index produced by the build-time
 * serializer must parse back via parseBinaryIndex.
 *
 * Before the fix, serializeBinaryOnlyIndex emitted `v: 3` (no full embeddings)
 * but parseBinaryIndex only accepted `v: 2` AND required the full embedding
 * field — so a freshly serialized binary-only index threw on load.
 */

import { describe, expect, it } from "vitest";
import { encodeBase64 } from "@lesto/content-shared/encoding";
import { parseBinaryIndex, binarySearch, binaryQuantize } from "../src/binary";
import type { BinarySearchIndex } from "../src/types";

// Mirror of @lesto/content-embeddings serializeBinaryOnlyIndex (v3, binary-only).
// Inlined to avoid loading the embeddings package (it pulls @huggingface/transformers
// at module load), while still exercising the exact wire format the writer emits.
function serializeBinaryOnlyIndex(index: BinarySearchIndex): string {
  const compact = {
    v: 3 as const,
    m: index.model,
    d: index.dimensions,
    b: index.builtAt,
    bs: index.binarySize,
    e: index.entries.map((entry) => ({
      i: entry.id,
      s: entry.slug,
      c: entry.collection,
      t: entry.title,
      n: entry.snippet,
      b: encodeBase64(entry.binaryEmbedding),
    })),
  };
  return JSON.stringify(compact);
}

function makeIndex(): BinarySearchIndex {
  const dims = 8;
  const e1 = [1, 1, -1, 1, -1, -1, 1, -1];
  const e2 = [-1, -1, 1, -1, 1, 1, -1, 1];

  return {
    dimensions: dims,
    model: "test-model",
    builtAt: "2026-06-09T00:00:00.000Z",
    binarySize: Math.ceil(dims / 8),
    entries: [
      {
        id: "a",
        slug: "alpha",
        collection: "docs",
        title: "Alpha",
        snippet: "first",
        embedding: e1,
        binaryEmbedding: binaryQuantize(e1),
      },
      {
        id: "b",
        slug: "beta",
        collection: "docs",
        title: "Beta",
        snippet: "second",
        embedding: e2,
        binaryEmbedding: binaryQuantize(e2),
      },
    ],
  };
}

describe("binary index v3 round-trip", () => {
  it("parses a freshly serialized binary-only (v3) index", () => {
    const json = serializeBinaryOnlyIndex(makeIndex());

    const parsed = parseBinaryIndex(json);

    expect(parsed.entries).toHaveLength(2);
    expect(parsed.dimensions).toBe(8);
    expect(parsed.model).toBe("test-model");
    expect(parsed.binarySize).toBe(1);
  });

  it("preserves binary signatures so Hamming search still works on v3", () => {
    const index = makeIndex();
    const json = serializeBinaryOnlyIndex(index);

    const parsed = parseBinaryIndex(json);

    // Binary signatures survive the round-trip byte-for-byte.
    expect(Array.from(parsed.entries[0]!.binaryEmbedding)).toEqual(
      Array.from(index.entries[0]!.binaryEmbedding),
    );

    // Querying with entry a's embedding ranks a first.
    const results = binarySearch([1, 1, -1, 1, -1, -1, 1, -1], parsed, {
      limit: 1,
      threshold: 0,
    });
    expect(results[0]!.id).toBe("a");
  });

  it("leaves full embeddings empty for v3 (binary-only carries no float vectors)", () => {
    const parsed = parseBinaryIndex(serializeBinaryOnlyIndex(makeIndex()));
    expect(parsed.entries[0]!.embedding).toEqual([]);
  });

  it("still parses a v2 index with full embeddings", () => {
    // v2: includes the base64 float32 embedding under `e`.
    const dims = 8;
    const embedding = [1, 1, -1, 1, -1, -1, 1, -1];
    const v2 = {
      v: 2 as const,
      m: "test-model",
      d: dims,
      b: "2026-06-09T00:00:00.000Z",
      bs: 1,
      e: [
        {
          i: "a",
          s: "alpha",
          c: "docs",
          t: "Alpha",
          n: "first",
          e: encodeBase64(new Uint8Array(new Float32Array(embedding).buffer)),
          b: encodeBase64(binaryQuantize(embedding)),
        },
      ],
    };

    const parsed = parseBinaryIndex(JSON.stringify(v2));
    expect(parsed.entries[0]!.embedding).toHaveLength(dims);
    expect(parsed.entries[0]!.embedding[0]).toBeCloseTo(1);
  });

  it("rejects an unknown version", () => {
    const bad = JSON.stringify({ v: 99, m: "x", d: 8, b: "t", bs: 1, e: [] });
    expect(() => parseBinaryIndex(bad)).toThrow(/Unsupported binary index version: 99/);
  });
});
