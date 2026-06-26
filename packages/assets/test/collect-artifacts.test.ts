/**
 * The pure flatten of Vite's in-memory Rollup output into the {@link BundleArtifact}s the
 * orchestration writes — extracted from the coverage-excluded `vite-build.ts` so it is
 * asserted directly. The Rollup output objects are built as plain literals matching the
 * `Rollup.RollupOutput` shape and cast to the type; `collectArtifacts` only ever reads
 * `output`, `type`, `isEntry`, `fileName`, `code`, and `source`, so a partial fake is
 * faithful to what it touches.
 */

import type { Rollup } from "vite";
import { describe, expect, it } from "vitest";

import { collectArtifacts } from "../src/collect-artifacts";

/** A Rollup `chunk` output item, with only the fields `collectArtifacts` reads. */
function chunk(fileName: string, code: string, isEntry: boolean): unknown {
  return { type: "chunk", isEntry, fileName, code };
}

/** A Rollup `asset` output item, with only the fields `collectArtifacts` reads. */
function asset(fileName: string, source: string | Uint8Array): unknown {
  return { type: "asset", fileName, source };
}

/** Wrap output items into a `RollupOutput`-shaped object. */
function output(items: unknown[]): Rollup.RollupOutput {
  return { output: items } as Rollup.RollupOutput;
}

describe("collectArtifacts", () => {
  it("accepts a single RollupOutput (not an array)", () => {
    const result = output([chunk("client.js", "ENTRY", true)]);

    expect(collectArtifacts(result)).toEqual([
      { kind: "entry", fileName: "client.js", contents: "ENTRY" },
    ]);
  });

  it("flattens an array of RollupOutputs", () => {
    const result = [output([chunk("a.js", "A", true)]), output([chunk("chunk-b.js", "B", false)])];

    expect(collectArtifacts(result)).toEqual([
      { kind: "entry", fileName: "a.js", contents: "A" },
      { kind: "chunk", fileName: "chunk-b.js", contents: "B" },
    ]);
  });

  it("maps isEntry → entry and a non-entry chunk → chunk", () => {
    const result = output([chunk("client.js", "ENTRY", true), chunk("chunk-x.js", "LAZY", false)]);

    expect(collectArtifacts(result)).toEqual([
      { kind: "entry", fileName: "client.js", contents: "ENTRY" },
      { kind: "chunk", fileName: "chunk-x.js", contents: "LAZY" },
    ]);
  });

  it("carries an asset through as a chunk with its string source", () => {
    const result = output([
      chunk("client.js", "ENTRY", true),
      asset("asset-styles.css", ".a{color:red}"),
    ]);

    expect(collectArtifacts(result)).toEqual([
      { kind: "entry", fileName: "client.js", contents: "ENTRY" },
      { kind: "chunk", fileName: "asset-styles.css", contents: ".a{color:red}" },
    ]);
  });

  it("carries a binary (Uint8Array) asset source through unchanged", () => {
    const bytes = new Uint8Array([1, 2, 3]);

    const result = output([asset("asset-logo.png", bytes)]);

    const artifacts = collectArtifacts(result);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe("chunk");
    expect(artifacts[0]?.fileName).toBe("asset-logo.png");
    // The same Uint8Array instance rides through — never coerced to a string.
    expect(artifacts[0]?.contents).toBe(bytes);
  });

  it("handles a mixed entry + chunk + asset output", () => {
    const result = output([
      chunk("client.js", "ENTRY", true),
      chunk("chunk-lazy.js", "LAZY", false),
      asset("asset-img.svg", "<svg/>"),
    ]);

    expect(collectArtifacts(result)).toEqual([
      { kind: "entry", fileName: "client.js", contents: "ENTRY" },
      { kind: "chunk", fileName: "chunk-lazy.js", contents: "LAZY" },
      { kind: "chunk", fileName: "asset-img.svg", contents: "<svg/>" },
    ]);
  });
});
