/**
 * Regression: serializeBinaryOnlyIndex must emit a format the runtime parser
 * (@volo/content-search parseBinaryIndex) can read.
 *
 * The writer emits `v: 3` with binary-only entries (no full embedding field).
 * This test pins that wire shape; the matching reader fix lives in
 * @volo/content-search/src/binary.ts (which now accepts v2 and v3).
 */

import { describe, expect, it } from "vitest";
import {
  binaryQuantize,
  createBinaryIndex,
  serializeBinaryOnlyIndex,
  serializeBinaryIndex,
} from "../src/binary";
import type { EmbeddingResult } from "../src/types";

function makeEntries(): EmbeddingResult[] {
  return [
    {
      id: "a",
      slug: "alpha",
      collection: "docs",
      title: "Alpha",
      snippet: "first",
      embedding: [1, 1, -1, 1, -1, -1, 1, -1],
    },
    {
      id: "b",
      slug: "beta",
      collection: "docs",
      title: "Beta",
      snippet: "second",
      embedding: [-1, -1, 1, -1, 1, 1, -1, 1],
    },
  ];
}

describe("serializeBinaryOnlyIndex wire format", () => {
  it("emits v3 with binary-only entries (no full embedding field)", () => {
    const index = createBinaryIndex(makeEntries());

    const parsed = JSON.parse(serializeBinaryOnlyIndex(index)) as {
      v: number;
      e: Array<Record<string, unknown>>;
    };

    expect(parsed.v).toBe(3);
    expect(parsed.e).toHaveLength(2);
    // Binary signature present, full embedding absent.
    expect(typeof parsed.e[0]!["b"]).toBe("string");
    expect(parsed.e[0]!["e"]).toBeUndefined();
  });

  it("emits v2 WITH full embeddings for the rerankable serializer", () => {
    const index = createBinaryIndex(makeEntries());

    const parsed = JSON.parse(serializeBinaryIndex(index)) as {
      v: number;
      e: Array<Record<string, unknown>>;
    };

    expect(parsed.v).toBe(2);
    expect(typeof parsed.e[0]!["e"]).toBe("string");
    expect(typeof parsed.e[0]!["b"]).toBe("string");
  });

  it("binary signatures in the v3 payload match the quantized embeddings", () => {
    const entries = makeEntries();
    const index = createBinaryIndex(entries);

    const parsed = JSON.parse(serializeBinaryOnlyIndex(index)) as {
      e: Array<{ b: string }>;
    };

    const expected = Buffer.from(binaryQuantize(entries[0]!.embedding)).toString("base64");
    expect(parsed.e[0]!.b).toBe(expected);
  });
});
