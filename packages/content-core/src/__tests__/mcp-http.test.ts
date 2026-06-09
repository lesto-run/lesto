import { describe, it, expect } from "vitest";
import { validateToolArgs, ALL_TOOLS } from "../mcp-http";

/**
 * Regression coverage: HTTP MCP tool arguments are validated against the
 * advertised JSON Schema before dispatch, so a missing required field or a
 * wrong-typed value produces a clear error instead of an opaque downstream
 * TypeError or a malformed request to the Studio API.
 */
describe("validateToolArgs", () => {
  it("rejects missing required arguments", () => {
    const tool = ALL_TOOLS["get_entry"]!;
    const error = validateToolArgs(tool, { collection: "posts" });

    expect(error).toContain('Missing required argument "slug"');
  });

  it("rejects a wrong-typed required argument", () => {
    const tool = ALL_TOOLS["search_content"]!;
    const error = validateToolArgs(tool, { query: 123 });

    expect(error).toContain('Argument "query"');
    expect(error).toContain("string");
  });

  it("rejects a wrong-typed optional argument", () => {
    const tool = ALL_TOOLS["search_content"]!;
    const error = validateToolArgs(tool, { query: "hi", limit: "ten" });

    expect(error).toContain('Argument "limit"');
  });

  it("accepts valid arguments", () => {
    const tool = ALL_TOOLS["search_content"]!;
    const error = validateToolArgs(tool, { query: "hi", limit: 5, collection: "posts" });

    expect(error).toBeNull();
  });

  it("accepts object-typed and array-typed arguments", () => {
    const create = ALL_TOOLS["create_entry"]!;
    expect(validateToolArgs(create, { collection: "p", slug: "s", data: { a: 1 } })).toBeNull();

    const training = ALL_TOOLS["voice_training_prepare"]!;
    expect(validateToolArgs(training, { collection: "p", instructionTypes: ["write"] })).toBeNull();
  });
});
