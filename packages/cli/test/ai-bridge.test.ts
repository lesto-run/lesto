import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CliError } from "../src/errors";
import { dispatchAiTurn, READ_TOOL_ALLOWLIST } from "../src/ai-bridge";
import type { AiBridgeDeps, AiTurn } from "../src/ai-bridge";
import { redactContext } from "../src/ai-redact";

/**
 * The in-preview AI dispatch bridge (ADR 0033 Inc 3) — the fail-closed Phase-1 boundary.
 *
 * `dispatchAiTurn` is a pure gate: a positive read-tool allowlist first (independent of the
 * seam), then the seam-presence check. These tests prove the load-bearing property — a
 * non-allowlisted tool is refused EVEN when a write-capable seam is injected — plus the
 * absent-seam and forwarding branches, and the layering invariant (no `@lesto/mcp` import).
 */

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The one allowlisted read-only tool the Phase-1 bridge forwards. */
const ALLOWED = READ_TOOL_ALLOWLIST[0];

// A turn's `input` is the BRANDED `RedactedContext` — the only way to obtain one is to run a
// payload through `redactContext`, so the type system alone forbids handing the bridge an
// un-redacted payload. The tests build their inputs the one sanctioned way.
const redacted = redactContext({ route: "/posts" });

describe("dispatchAiTurn", () => {
  it("forwards an allowlisted read tool to the injected seam and returns its result", async () => {
    const dispatchDevTool = vi.fn(() => Promise.resolve({ collections: ["posts"] }));

    const result = await dispatchAiTurn({ dispatchDevTool }, { tool: ALLOWED, input: redacted });

    expect(result).toEqual({ collections: ["posts"] });
    // The exact turn (tool + redacted input) is what the seam receives.
    expect(dispatchDevTool).toHaveBeenCalledWith({ tool: ALLOWED, input: redacted });
  });

  it("refuses a WRITE-shaped tool with CLI_DEV_MCP_UNAVAILABLE even when a write-capable seam is injected", async () => {
    // The whole point of a POSITIVE allowlist: a write-capable seam is present, but a
    // non-allowlisted (mutation-shaped) name never reaches it.
    const dispatchDevTool = vi.fn(() => Promise.resolve("should never run"));

    const error = await dispatchAiTurn({ dispatchDevTool }, { tool: "update_content_entry" }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("CLI_DEV_MCP_UNAVAILABLE");
    expect(dispatchDevTool).not.toHaveBeenCalled();
  });

  it("refuses an UNKNOWN tool name too (allowlist, not a write-verb denylist)", async () => {
    const dispatchDevTool = vi.fn(() => Promise.resolve("nope"));

    const error = await dispatchAiTurn({ dispatchDevTool }, { tool: "frobnicate" }).catch(
      (cause: unknown) => cause,
    );

    expect((error as CliError).code).toBe("CLI_DEV_MCP_UNAVAILABLE");
    expect(dispatchDevTool).not.toHaveBeenCalled();
  });

  it("refuses an allowlisted tool when NO dispatch seam is wired (fail closed, not open)", async () => {
    const deps: AiBridgeDeps = {};

    const error = await dispatchAiTurn(deps, { tool: ALLOWED }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("CLI_DEV_MCP_UNAVAILABLE");
  });

  it("carries the offending tool name in the coded error's details (branch on code, not message)", async () => {
    const error = (await dispatchAiTurn({}, { tool: "frobnicate" }).catch(
      (cause: unknown) => cause,
    )) as CliError;

    expect(error.code).toBe("CLI_DEV_MCP_UNAVAILABLE");
    expect(error.details).toMatchObject({ tool: "frobnicate" });
  });

  it("REJECTS an un-redacted payload at COMPILE time (the redactor-bypass guard)", () => {
    // A raw, un-redacted context (an absolute path in `handlerLocation`) is structurally an
    // `AiContextPayload` but is NOT the branded `RedactedContext`, so the type system refuses
    // it as a turn's input — the model can never receive a non-redacted payload. If the brand
    // were ever dropped, the assignment below would compile and `@ts-expect-error` would fail
    // the build. (The directive must sit DIRECTLY above the erroring line — keep it one line.)
    const raw = { route: "/x", handlerLocation: "/Users/me/app.ts:3" };
    // @ts-expect-error — unbranded (un-redacted) payload is not assignable to `RedactedContext`.
    const bypass: AiTurn = { tool: ALLOWED, input: raw };

    expect(bypass.tool).toBe(ALLOWED);
  });

  it("names no @lesto/mcp import — the dispatch is an injected seam only (layering invariant)", () => {
    const source = readFileSync(join(srcDir, "ai-bridge.ts"), "utf8");

    // Match the QUOTED import specifier, not bare prose: the doc-comment cites the invariant
    // in backticks (`@lesto/mcp`), so assert on the `"@lesto/mcp"` / `'@lesto/mcp'` an actual
    // `import`/`import()` would carry (the mcp-package layering-grep idiom).
    expect(source).not.toContain('"@lesto/mcp"');
    expect(source).not.toContain("'@lesto/mcp'");
  });
});
