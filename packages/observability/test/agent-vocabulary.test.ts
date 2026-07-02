import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AI_GENERATE_SPAN,
  AI_MODEL_ATTR,
  AI_STOP_REASON_ATTR,
  AI_STREAMING_ATTR,
  AI_TOOL_NAME_ATTR,
  AI_TOOL_SPAN,
  AI_USAGE_INPUT_TOKENS_ATTR,
  AI_USAGE_OUTPUT_TOKENS_ATTR,
  MCP_DURATION_MS_ATTR,
  MCP_INPUT_HASH_ATTR,
  MCP_OUTCOME_ATTR,
  MCP_TOOL_ATTR,
  MCP_TOOL_SPAN,
  mcpAuditToSpanAttributes,
} from "../src/agent-vocabulary";

import type { McpAuditShape } from "../src/agent-vocabulary";

describe("span names", () => {
  it("are the exact OTel-flavored values the two emitters agree on", () => {
    expect(AI_GENERATE_SPAN).toBe("ai.generate");
    expect(AI_TOOL_SPAN).toBe("ai.tool");
    expect(MCP_TOOL_SPAN).toBe("mcp.tool");
  });
});

describe("attribute keys", () => {
  it("are the exact `ai.*` keys", () => {
    expect(AI_MODEL_ATTR).toBe("ai.model");
    expect(AI_USAGE_INPUT_TOKENS_ATTR).toBe("ai.usage.input_tokens");
    expect(AI_USAGE_OUTPUT_TOKENS_ATTR).toBe("ai.usage.output_tokens");
    expect(AI_STOP_REASON_ATTR).toBe("ai.stop_reason");
    expect(AI_STREAMING_ATTR).toBe("ai.streaming");
    expect(AI_TOOL_NAME_ATTR).toBe("ai.tool.name");
  });

  it("are the exact `mcp.*` keys", () => {
    expect(MCP_TOOL_ATTR).toBe("mcp.tool");
    expect(MCP_INPUT_HASH_ATTR).toBe("mcp.input_hash");
    expect(MCP_OUTCOME_ATTR).toBe("mcp.outcome");
    expect(MCP_DURATION_MS_ATTR).toBe("mcp.duration_ms");
  });
});

// Every `.ts` file under a directory, recursively.
const tsFilesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return tsFilesUnder(path);

    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });

// Quoted-specifier match (bare OR subpath); doc-comment prose (backtick-quoted) is not a hit.
const importsPackage = (pkg: string): RegExp => new RegExp(`["']${pkg}(/[^"']*)?["']`);

describe("layering (ADR 0031 — the vocabulary is structural)", () => {
  const srcDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

  it("@lesto/observability imports neither @lesto/mcp nor @lesto/ai (the mapper takes a structural record)", () => {
    const offenders = tsFilesUnder(srcDir).filter((file) => {
      const source = readFileSync(file, "utf8");

      return importsPackage("@lesto/mcp").test(source) || importsPackage("@lesto/ai").test(source);
    });

    expect(offenders).toEqual([]);
  });
});

describe("mcpAuditToSpanAttributes", () => {
  it("maps every audit field onto its `mcp.*` attribute (the full mapping)", () => {
    const record: McpAuditShape = {
      tool: "handle_request",
      inputHash: "a".repeat(64),
      outcome: "ok",
      durationMs: 42,
    };

    expect(mcpAuditToSpanAttributes(record)).toEqual({
      "mcp.tool": "handle_request",
      "mcp.input_hash": "a".repeat(64),
      "mcp.outcome": "ok",
      "mcp.duration_ms": 42,
    });
  });

  it("carries the `error` outcome through unchanged", () => {
    const record: McpAuditShape = {
      tool: "delete_content_entry",
      inputHash: "b".repeat(64),
      outcome: "error",
      durationMs: 7,
    };

    expect(mcpAuditToSpanAttributes(record).outcome).toBeUndefined();
    expect(mcpAuditToSpanAttributes(record)[MCP_OUTCOME_ATTR]).toBe("error");
  });
});
