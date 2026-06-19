import { describe, expect, it } from "vitest";

import { createAnthropic } from "../src/anthropic";
import { generateText } from "../src/generate";
import { cosineSimilarity, MemoryVectorStore, retrieve } from "../src/retrieval";

import { constantTransport, jsonResponse, textMessage } from "./fake-transport";

import type { VectorRecord } from "../src/retrieval";

const docs: VectorRecord[] = [
  { id: "a", embedding: [1, 0, 0], text: "Lesto ships a queue." },
  { id: "b", embedding: [0, 1, 0], text: "Lesto ships durable stores." },
  { id: "c", embedding: [0.9, 0.1, 0], text: "Lesto's queue is at-least-once." },
];

describe("cosineSimilarity", () => {
  it("is 1 for identical direction and 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is 0 (not NaN) for a zero-magnitude vector", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });

  it("compares only the overlapping prefix of mismatched-length vectors", () => {
    expect(cosineSimilarity([1, 0, 99], [1, 0])).toBeCloseTo(1);
  });
});

describe("MemoryVectorStore", () => {
  it("upserts and returns the topK nearest, most similar first", async () => {
    const store = new MemoryVectorStore();
    await store.upsert(docs);

    const matches = await store.query([1, 0, 0], { topK: 2 });

    expect(matches.map((m) => m.record.id)).toEqual(["a", "c"]);
    expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? 0);
  });

  it("replaces a record on re-upsert by id", async () => {
    const store = new MemoryVectorStore();
    await store.upsert([{ id: "a", embedding: [1, 0], text: "old" }]);
    await store.upsert([{ id: "a", embedding: [1, 0], text: "new" }]);

    const matches = await store.query([1, 0], { topK: 5 });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.record.text).toBe("new");
  });

  it("clamps a negative topK to zero matches", async () => {
    const store = new MemoryVectorStore();
    await store.upsert(docs);

    expect(await store.query([1, 0, 0], { topK: -3 })).toEqual([]);
  });
});

describe("retrieve", () => {
  it("assembles the matched chunks into a context block", async () => {
    const store = new MemoryVectorStore();
    await store.upsert(docs);

    const { matches, context } = await retrieve({ store, embedding: [1, 0, 0], topK: 2 });

    expect(matches).toHaveLength(2);
    expect(context).toBe("Lesto ships a queue.\n\nLesto's queue is at-least-once.");
  });

  it("flows one RAG retrieval into a generation (the full retrieve-then-generate loop)", async () => {
    const store = new MemoryVectorStore();
    await store.upsert(docs);

    const { context } = await retrieve({ store, embedding: [1, 0, 0], topK: 1 });

    const { transport, requests } = constantTransport(
      jsonResponse(textMessage("The queue is at-least-once.")),
    );
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const { text } = await generateText({
      model,
      system: `Answer using only this context:\n${context}`,
      messages: [{ role: "user", content: "Is the queue at-least-once?" }],
    });

    expect(text).toBe("The queue is at-least-once.");

    // The retrieved context actually rode into the model request.
    const sent = (await requests[0]?.json()) as Record<string, unknown>;
    expect(sent["system"]).toContain("Lesto ships a queue.");
  });
});
