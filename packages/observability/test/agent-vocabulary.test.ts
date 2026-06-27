import { describe, expect, it } from "vitest";

import {
  AI_GENERATE_SPAN,
  AI_MODEL_ATTR,
  AI_STOP_REASON_ATTR,
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
    expect(AI_TOOL_NAME_ATTR).toBe("ai.tool.name");
  });

  it("are the exact `mcp.*` keys", () => {
    expect(MCP_TOOL_ATTR).toBe("mcp.tool");
    expect(MCP_INPUT_HASH_ATTR).toBe("mcp.input_hash");
    expect(MCP_OUTCOME_ATTR).toBe("mcp.outcome");
    expect(MCP_DURATION_MS_ATTR).toBe("mcp.duration_ms");
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
