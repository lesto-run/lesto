import { describe, it, expect } from "vitest";
import { nn } from "./test-utils";
import {
  countWords,
  chunkContent,
  chunkVoiceSample,
  chunkVoiceSamples,
  generateInstruction,
  generateInstructionsForChunk,
  generateTrainingData,
  formatTrainingPair,
  exportAsJSONL,
  exportAsAlpaca,
  calculateTrainingStats,
  type ContentChunk,
} from "../voice-training";
import type { VoiceSample } from "../voice";

// Helper to create a voice sample
function createSample(overrides: Partial<VoiceSample> = {}): VoiceSample {
  return {
    entryId: "test-entry",
    collection: "posts",
    content: "This is test content.",
    isExemplary: false,
    ...overrides,
  };
}

// Helper to create content of a specific word count
function createContent(wordCount: number): string {
  const words = Array.from({ length: wordCount }, (_, i) => `word${i}`);
  return words.join(" ");
}

describe("Voice Training", () => {
  describe("countWords", () => {
    it("counts words in simple text", () => {
      expect(countWords("hello world")).toBe(2);
      expect(countWords("one two three four five")).toBe(5);
    });

    it("handles multiple spaces", () => {
      expect(countWords("hello    world")).toBe(2);
    });

    it("handles newlines and tabs", () => {
      expect(countWords("hello\nworld\tthere")).toBe(3);
    });

    it("handles empty strings", () => {
      expect(countWords("")).toBe(0);
      expect(countWords("   ")).toBe(0);
    });
  });

  describe("chunkContent", () => {
    it("returns single chunk for content under minimum", () => {
      const content = createContent(100);
      const chunks = chunkContent(content);
      expect(chunks).toHaveLength(1);
      expect(countWords(nn(chunks[0]))).toBe(100);
    });

    it("returns single chunk for content within range", () => {
      const content = createContent(400);
      const chunks = chunkContent(content);
      expect(chunks).toHaveLength(1);
      expect(countWords(nn(chunks[0]))).toBe(400);
    });

    it("splits content exceeding maximum", () => {
      const content = createContent(1000);
      const chunks = chunkContent(content);
      expect(chunks.length).toBeGreaterThan(1);

      // All chunks should be within range
      for (const chunk of chunks) {
        const words = countWords(chunk);
        expect(words).toBeLessThanOrEqual(650);
      }
    });

    it("respects custom min/max options", () => {
      const content = createContent(200);
      const chunks = chunkContent(content, {
        minWords: 50,
        maxWords: 100,
      });
      expect(chunks.length).toBeGreaterThan(1);

      for (const chunk of chunks) {
        const words = countWords(chunk);
        expect(words).toBeLessThanOrEqual(100);
      }
    });

    it("returns empty array for short content when not allowed", () => {
      const content = createContent(50);
      const chunks = chunkContent(content, {
        minWords: 100,
        allowShortContent: false,
      });
      expect(chunks).toHaveLength(0);
    });

    it("allows short content when specified", () => {
      const content = createContent(50);
      const chunks = chunkContent(content, {
        minWords: 100,
        allowShortContent: true,
      });
      expect(chunks).toHaveLength(1);
    });

    it("prefers paragraph breaks for splitting", () => {
      const content = `This is the first paragraph with enough content to make it substantial.\n\nThis is the second paragraph with more content for testing purposes.\n\nAnd a third paragraph here for good measure.`;
      const chunks = chunkContent(content, {
        minWords: 5,
        maxWords: 20,
        targetWords: 10,
      });

      // Should respect paragraph structure where possible
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("prefers sentence breaks when no paragraph break available", () => {
      const content =
        "This is sentence one. This is sentence two. This is sentence three. This is sentence four.";
      const chunks = chunkContent(content, {
        minWords: 3,
        maxWords: 8,
        targetWords: 5,
      });

      // Should split at sentence boundaries
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    // Edge case tests for infinite loop prevention (m0-abc)
    describe("edge cases for infinite loop prevention", () => {
      it("handles empty content without infinite loop", () => {
        // Empty content returns single empty chunk when allowShortContent is true (default)
        const chunks = chunkContent("");
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toBe("");
      });

      it("handles whitespace-only content without infinite loop", () => {
        // Whitespace-only content trims to empty string
        const chunks = chunkContent("   \n\t\n   ");
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toBe("");
      });

      it("handles content with only special characters", () => {
        const chunks = chunkContent("!@#$%^&*()");
        // Single "word" of special chars
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toBe("!@#$%^&*()");
      });

      it("handles single character content", () => {
        const chunks = chunkContent("a");
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toBe("a");
      });

      it("handles content that could produce zero breakPoint", () => {
        // Content designed to potentially trigger edge case where
        // breakPoint calculation might return 0
        const chunks = chunkContent("x", { minWords: 1, maxWords: 1, targetWords: 1 });
        expect(chunks).toHaveLength(1);
      });

      it("completes within reasonable time for long content", () => {
        const start = Date.now();
        const longContent = createContent(10000);
        const chunks = chunkContent(longContent);
        const elapsed = Date.now() - start;

        // Should complete quickly, not hang
        expect(elapsed).toBeLessThan(5000);
        expect(chunks.length).toBeGreaterThan(0);
      });
    });
  });

  describe("chunkVoiceSample", () => {
    it("creates chunks from voice sample", () => {
      const sample = createSample({
        entryId: "post-1",
        collection: "blog",
        content: createContent(500),
        title: "Test Post",
        author: "John",
        isExemplary: true,
      });

      const chunks = chunkVoiceSample(sample);
      expect(chunks).toHaveLength(1);

      const chunk = nn(chunks[0]);
      expect(chunk.entryId).toBe("post-1");
      expect(chunk.collection).toBe("blog");
      expect(chunk.author).toBe("John");
      expect(chunk.sourceTitle).toBe("Test Post");
      expect(chunk.isExemplary).toBe(true);
      expect(chunk.chunkIndex).toBe(0);
      expect(chunk.totalChunks).toBe(1);
    });

    it("creates multiple chunks for long content", () => {
      const sample = createSample({
        content: createContent(1000),
      });

      const chunks = chunkVoiceSample(sample);
      expect(chunks.length).toBeGreaterThan(1);

      // Check chunk indices
      chunks.forEach((chunk, i) => {
        expect(chunk.chunkIndex).toBe(i);
        expect(chunk.totalChunks).toBe(chunks.length);
      });
    });

    it("generates unique chunk IDs", () => {
      const sample = createSample({
        entryId: "entry-123",
        content: createContent(1000),
      });

      const chunks = chunkVoiceSample(sample);
      const ids = chunks.map((c) => c.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(chunks.length);
      expect(nn(chunks[0]).id).toContain("entry-123");
    });
  });

  describe("chunkVoiceSamples", () => {
    it("chunks multiple samples", () => {
      const samples = [
        createSample({ entryId: "post-1", content: createContent(400) }),
        createSample({ entryId: "post-2", content: createContent(400) }),
      ];

      const chunks = chunkVoiceSamples(samples);
      expect(chunks).toHaveLength(2);
      expect(nn(chunks[0]).entryId).toBe("post-1");
      expect(nn(chunks[1]).entryId).toBe("post-2");
    });

    it("flattens chunks from multiple samples", () => {
      const samples = [
        createSample({ entryId: "post-1", content: createContent(1000) }),
        createSample({ entryId: "post-2", content: createContent(1000) }),
      ];

      const chunks = chunkVoiceSamples(samples);
      expect(chunks.length).toBeGreaterThan(2);
    });
  });

  describe("generateInstruction", () => {
    it("generates instruction for a chunk", () => {
      const chunk: ContentChunk = {
        id: "chunk-1",
        entryId: "post-1",
        collection: "posts",
        text: "This is some sample content for testing.",
        wordCount: 7,
        chunkIndex: 0,
        totalChunks: 1,
        isExemplary: false,
      };

      const instruction = generateInstruction(chunk, "write");
      expect(instruction.id).toContain("chunk-1");
      expect(instruction.output).toBe(chunk.text);
      expect(instruction.type).toBe("write");
      expect(instruction.chunkId).toBe("chunk-1");
      expect(instruction.instruction).toBeTruthy();
    });

    it("generates different instructions for different types", () => {
      const chunk: ContentChunk = {
        id: "chunk-1",
        entryId: "post-1",
        collection: "posts",
        text: "Test content here.",
        wordCount: 3,
        chunkIndex: 0,
        totalChunks: 1,
        isExemplary: false,
      };

      const writeInst = generateInstruction(chunk, "write");
      const explainInst = generateInstruction(chunk, "explain");

      expect(writeInst.instruction).not.toBe(explainInst.instruction);
      expect(writeInst.type).toBe("write");
      expect(explainInst.type).toBe("explain");
    });
  });

  describe("generateInstructionsForChunk", () => {
    it("generates multiple instruction types", () => {
      const chunk: ContentChunk = {
        id: "chunk-1",
        entryId: "post-1",
        collection: "posts",
        text: "Sample content.",
        wordCount: 2,
        chunkIndex: 0,
        totalChunks: 1,
        isExemplary: false,
      };

      const instructions = generateInstructionsForChunk(chunk, [
        "write",
        "explain",
        "elaborate",
      ]);

      expect(instructions).toHaveLength(3);
      expect(instructions.map((i) => i.type)).toContain("write");
      expect(instructions.map((i) => i.type)).toContain("explain");
      expect(instructions.map((i) => i.type)).toContain("elaborate");
    });
  });

  describe("formatTrainingPair", () => {
    it("formats instruction pair as training pair", () => {
      const instruction = {
        id: "inst-1",
        instruction: "Write about testing.",
        output: "Testing is important for code quality.",
        type: "write" as const,
        chunkId: "chunk-1",
        entryId: "post-1",
        collection: "posts",
        author: "Jane",
        isExemplary: true,
      };

      const pair = formatTrainingPair(instruction);

      expect(pair.id).toBe("inst-1");
      expect(pair.input).toBe("Write about testing.");
      expect(pair.output).toBe("Testing is important for code quality.");
      expect(pair.metadata.entryId).toBe("post-1");
      expect(pair.metadata.collection).toBe("posts");
      expect(pair.metadata.author).toBe("Jane");
      expect(pair.metadata.type).toBe("write");
      expect(pair.metadata.isExemplary).toBe(true);
      expect(pair.metadata.wordCount).toBe(6);
    });
  });

  describe("generateTrainingData", () => {
    it("generates training data from samples", () => {
      const samples = [
        createSample({
          entryId: "post-1",
          content: createContent(400),
          isExemplary: false,
        }),
      ];

      const pairs = generateTrainingData(samples);

      expect(pairs.length).toBeGreaterThan(0);
      expect(nn(pairs[0]).input).toBeTruthy();
      expect(nn(pairs[0]).output).toBeTruthy();
      expect(nn(pairs[0]).metadata.entryId).toBe("post-1");
    });

    it("duplicates exemplary content when prioritized", () => {
      const samples = [
        createSample({
          entryId: "exemplary-1",
          content: createContent(400),
          isExemplary: true,
        }),
        createSample({
          entryId: "regular-1",
          content: createContent(400),
          isExemplary: false,
        }),
      ];

      const pairs = generateTrainingData(samples, {
        prioritizeExemplary: true,
        exemplaryMultiplier: 2,
        instructionTypes: ["write"],
      });

      // Exemplary content should appear twice
      const exemplaryPairs = pairs.filter((p) => p.metadata.isExemplary);
      const regularPairs = pairs.filter((p) => !p.metadata.isExemplary);

      expect(exemplaryPairs.length).toBe(regularPairs.length * 2);
    });
  });

  describe("exportAsJSONL", () => {
    it("exports pairs as JSONL format", () => {
      const pairs = [
        {
          id: "pair-1",
          input: "Write something",
          output: "Here is something",
          metadata: {
            entryId: "e1",
            collection: "posts",
            type: "write" as const,
            isExemplary: false,
            wordCount: 3,
          },
        },
        {
          id: "pair-2",
          input: "Explain this",
          output: "This is an explanation",
          metadata: {
            entryId: "e2",
            collection: "posts",
            type: "explain" as const,
            isExemplary: true,
            wordCount: 4,
          },
        },
      ];

      const jsonl = exportAsJSONL(pairs);
      const lines = jsonl.split("\n");

      expect(lines).toHaveLength(2);

      const parsed1 = JSON.parse(nn(lines[0]));
      expect(parsed1.instruction).toBe("Write something");
      expect(parsed1.output).toBe("Here is something");
      expect(parsed1.metadata).toBeUndefined();

      const parsed2 = JSON.parse(nn(lines[1]));
      expect(parsed2.instruction).toBe("Explain this");
    });

    it("includes metadata when requested", () => {
      const pairs = [
        {
          id: "pair-1",
          input: "Write",
          output: "Output",
          metadata: {
            entryId: "e1",
            collection: "posts",
            type: "write" as const,
            isExemplary: false,
            wordCount: 1,
          },
        },
      ];

      const jsonl = exportAsJSONL(pairs, { includeMetadata: true });
      const parsed = JSON.parse(jsonl);

      expect(parsed.metadata).toBeDefined();
      expect(parsed.metadata.entryId).toBe("e1");
    });
  });

  describe("exportAsAlpaca", () => {
    it("exports pairs in Alpaca format", () => {
      const pairs = [
        {
          id: "pair-1",
          input: "Write about cats",
          output: "Cats are wonderful pets.",
          metadata: {
            entryId: "e1",
            collection: "posts",
            type: "write" as const,
            isExemplary: false,
            wordCount: 4,
          },
        },
      ];

      const alpaca = exportAsAlpaca(pairs);

      expect(alpaca).toHaveLength(1);
      expect(nn(alpaca[0]).instruction).toBe("Write about cats");
      expect(nn(alpaca[0]).input).toBe("");
      expect(nn(alpaca[0]).output).toBe("Cats are wonderful pets.");
    });
  });

  describe("calculateTrainingStats", () => {
    it("calculates statistics for training data", () => {
      const pairs = [
        {
          id: "1",
          input: "i1",
          output: "Hello world",
          metadata: {
            entryId: "e1",
            collection: "posts",
            type: "write" as const,
            isExemplary: true,
            wordCount: 2,
          },
        },
        {
          id: "2",
          input: "i2",
          output: "Testing one two three",
          metadata: {
            entryId: "e2",
            collection: "blog",
            author: "John",
            type: "explain" as const,
            isExemplary: false,
            wordCount: 4,
          },
        },
      ];

      const stats = calculateTrainingStats(pairs);

      expect(stats.totalPairs).toBe(2);
      expect(stats.totalWords).toBe(6);
      expect(stats.averageWords).toBe(3);
      expect(stats.exemplaryPairs).toBe(1);
      expect(stats.byType.write).toBe(1);
      expect(stats.byType.explain).toBe(1);
      expect(stats.byCollection.posts).toBe(1);
      expect(stats.byCollection.blog).toBe(1);
      expect(stats.byAuthor.John).toBe(1);
    });

    it("handles empty pairs", () => {
      const stats = calculateTrainingStats([]);

      expect(stats.totalPairs).toBe(0);
      expect(stats.totalWords).toBe(0);
      expect(stats.averageWords).toBe(0);
      expect(stats.exemplaryPairs).toBe(0);
    });
  });
});
