import { describe, expect, test } from "vitest";

import { CliError } from "../src/errors";
import {
  isManagedRegionStale,
  MANAGED_REGION_END,
  MANAGED_REGION_START,
  mergeManagedRegion,
} from "../src/agents/managed-region";

const block = (inner: string): string => `${MANAGED_REGION_START}\n${inner}\n${MANAGED_REGION_END}`;

describe("mergeManagedRegion", () => {
  test("first run on an empty file emits just the wrapped block", () => {
    expect(mergeManagedRegion("", "BODY")).toBe(`${block("BODY")}\n`);
  });

  test("first run preserves a hand-written preamble and appends the block", () => {
    const merged = mergeManagedRegion("# My notes\n\nkeep me\n", "BODY");

    expect(merged).toBe(`# My notes\n\nkeep me\n\n${block("BODY")}\n`);
  });

  test("replaces only the region, preserving text before and after the markers", () => {
    const existing = `before\n\n${block("OLD")}\n\nafter\n`;

    expect(mergeManagedRegion(existing, "NEW")).toBe(`before\n\n${block("NEW")}\n\nafter\n`);
  });

  test("re-merging the same content is a byte-for-byte no-op (idempotent)", () => {
    const once = mergeManagedRegion("# preamble\n", "BODY");
    const twice = mergeManagedRegion(once, "BODY");

    expect(twice).toBe(once);
  });

  test("treats an inline prose mention of the markers as author text, not a region", () => {
    // An author documenting the marker syntax in their OWN prose must not have the
    // text between the mentions silently overwritten — the markers are not whole-line.
    const existing = `# Notes\n\nWe fence output with \`${MANAGED_REGION_START}\` … \`${MANAGED_REGION_END}\`.\n`;

    const merged = mergeManagedRegion(existing, "BODY");

    // The whole preamble (including the mentioned marker text) survives, and the
    // real managed block is appended after it — nothing is clobbered.
    expect(merged).toBe(`${existing.trimEnd()}\n\n${block("BODY")}\n`);
  });

  test("stays idempotent when the generated body itself contains a marker token", () => {
    // A scanned value rendered mid-line (e.g. a bullet) can contain the marker text;
    // because it is not alone on a line, it must not open a second region.
    const inner = `- \`${MANAGED_REGION_START}\` (page)`;

    const once = mergeManagedRegion("", inner);
    const twice = mergeManagedRegion(once, inner);

    expect(twice).toBe(once); // no throw, byte-identical
  });

  test("throws CLI_AGENTS_MARKER_MALFORMED on a duplicated start marker", () => {
    const existing = `${MANAGED_REGION_START}\na\n${MANAGED_REGION_START}\nb\n${MANAGED_REGION_END}`;

    expect(() => mergeManagedRegion(existing, "X")).toThrowError(
      expect.objectContaining({ code: "CLI_AGENTS_MARKER_MALFORMED" }),
    );
  });

  test("throws CLI_AGENTS_MARKER_MALFORMED when only a start marker is present", () => {
    try {
      mergeManagedRegion(`${MANAGED_REGION_START}\nbody, no end`, "X");
      expect.unreachable("expected a malformed-marker throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("CLI_AGENTS_MARKER_MALFORMED");
    }
  });

  test("throws CLI_AGENTS_MARKER_MALFORMED when the end marker precedes the start", () => {
    const inverted = `${MANAGED_REGION_END}\nbody\n${MANAGED_REGION_START}`;

    expect(() => mergeManagedRegion(inverted, "X")).toThrowError(
      expect.objectContaining({ code: "CLI_AGENTS_MARKER_MALFORMED" }),
    );
  });
});

describe("isManagedRegionStale", () => {
  test("is false when the file already carries exactly the merged content", () => {
    const fresh = mergeManagedRegion("", "BODY");

    expect(isManagedRegionStale(fresh, "BODY")).toBe(false);
  });

  test("is true when the region content differs", () => {
    const fresh = mergeManagedRegion("", "OLD");

    expect(isManagedRegionStale(fresh, "NEW")).toBe(true);
  });

  test("is true when the file has no managed region yet", () => {
    expect(isManagedRegionStale("# just notes\n", "BODY")).toBe(true);
  });

  test("propagates the malformed-marker error rather than masking it", () => {
    const malformed = `${MANAGED_REGION_START}\n${MANAGED_REGION_START}\n${MANAGED_REGION_END}`;

    expect(() => isManagedRegionStale(malformed, "X")).toThrowError(
      expect.objectContaining({ code: "CLI_AGENTS_MARKER_MALFORMED" }),
    );
  });
});
