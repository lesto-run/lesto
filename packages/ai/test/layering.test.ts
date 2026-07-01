/**
 * The layering line for the agent-observable spans (ADR 0031 Phase 2).
 *
 * `@lesto/ai` emits `ai.generate` / `ai.tool` spans through an INJECTED `AgentTracer`, so it
 * takes NO `@lesto/observability` edge — it stays the dependency-free model layer its package
 * description promises. This test pins that: no source file imports `@lesto/observability`, and
 * the span vocabulary it re-states holds the exact string values the canonical
 * `@lesto/observability` `agent-vocabulary` defines (asserted by literal so a typo drift is
 * caught here; the cross-PACKAGE agreement is the estate consumer's job, ADR 0031 Inc 4).
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AI_ERROR_CODE_ATTR,
  AI_GENERATE_SPAN,
  AI_MODEL_ATTR,
  AI_STOP_REASON_ATTR,
  AI_TOOL_NAME_ATTR,
  AI_TOOL_SPAN,
  AI_USAGE_INPUT_TOKENS_ATTR,
  AI_USAGE_OUTPUT_TOKENS_ATTR,
} from "../src/spans";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

/**
 * An `@lesto/observability` import specifier — the package name in a QUOTED module position
 * (static `from "…"` or dynamic `import("…")`), matched by the leading quote. Prose mentions
 * of the package in a doc comment (backticked, unquoted) are deliberately NOT matched: this
 * guards the dependency edge, not the documentation that explains why there isn't one.
 */
const OBSERVABILITY_IMPORT = /["']@lesto\/observability(?:\/[^"']*)?["']/;

/** Recursively collect every `.ts` source file under `dir`. */
async function collectSources(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) await collectSources(full, acc);
    else if (entry.name.endsWith(".ts")) acc.push(full);
  }

  return acc;
}

describe("@lesto/ai stays dependency-free of @lesto/observability", () => {
  it("no source file imports @lesto/observability", async () => {
    const files = await collectSources(SRC_DIR);

    // Sanity: the scan actually walked the package (not an empty glob), so a green result
    // means "checked every source", not "checked nothing".
    expect(files.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of files) {
      if (OBSERVABILITY_IMPORT.test(await readFile(file, "utf8"))) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it("re-states the canonical agent-vocabulary span names and attribute keys", () => {
    // These MUST equal @lesto/observability's `agent-vocabulary.ts` — asserted by literal
    // value so a within-package typo is caught without importing observability.
    expect(AI_GENERATE_SPAN).toBe("ai.generate");
    expect(AI_TOOL_SPAN).toBe("ai.tool");
    expect(AI_MODEL_ATTR).toBe("ai.model");
    expect(AI_USAGE_INPUT_TOKENS_ATTR).toBe("ai.usage.input_tokens");
    expect(AI_USAGE_OUTPUT_TOKENS_ATTR).toBe("ai.usage.output_tokens");
    expect(AI_STOP_REASON_ATTR).toBe("ai.stop_reason");
    expect(AI_TOOL_NAME_ATTR).toBe("ai.tool.name");
    // A preview @lesto/ai-local attribute (not in the shared vocabulary).
    expect(AI_ERROR_CODE_ATTR).toBe("ai.error_code");
  });
});
