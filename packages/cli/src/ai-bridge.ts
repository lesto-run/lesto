/**
 * The in-preview AI surface's dispatch bridge (ADR 0033 Phase 1, increment 3).
 *
 * The overlay (Inc 1) hands a turn — a NAMED dev tool plus its already-redacted input — to
 * this core, which decides whether that turn may reach the dev MCP server (ADR 0032). It is
 * the **load-bearing security boundary** of Phase 1, and it is fail-CLOSED by construction:
 *
 *   1. A POSITIVE read-tool allowlist ({@link READ_TOOL_ALLOWLIST}) is checked FIRST, before
 *      the seam is even consulted. A tool name that is not on the allowlist — an unknown name
 *      OR a write-shaped one — is refused with a coded `CLI_DEV_MCP_UNAVAILABLE`, EVEN when a
 *      write-capable seam is injected. This is a positive allowlist, deliberately NOT a
 *      "mutation-shaped" heuristic and NOT a write-verb denylist: a denylist fails open on the
 *      verb it forgot, an allowlist cannot. So Phase 1 has no reachable mutation path at all.
 *   2. Only an allowlisted name whose `dispatchDevTool` seam is actually wired forwards. An
 *      allowlisted turn with no seam (the ADR 0032 server absent) fails closed with the same
 *      coded refusal — which the overlay renders as its inspect-only "not available" state.
 *
 * ACTING — forwarding a mutation to a governed write tool — is Deferred to Phase 2, gated on
 * ADR 0032 committing a real edit/write verb under an attributed gate (ADR 0028). Until then
 * this stub guarantees no ungoverned mutation path can exist. Branch on the CODE, never the
 * message. `@lesto/cli` gains no runtime `@lesto/mcp` import — the dispatch is an injected
 * seam (the `generateUi?` precedent), so this file names no MCP package.
 */

import { CliError } from "./errors";
import type { RedactedContext } from "./ai-redact";

/**
 * The POSITIVE allowlist of read-only dev tool names a Phase-1 turn may reach. This is the
 * whole security boundary: a name absent here is refused before the seam runs. Kept as a
 * `const` tuple so the set is legible and greppable; extend it only with a genuinely
 * read-only tool (a mutating tool belongs to Phase 2's attributed gate, not here). Both
 * entries are read-only ADR-0034 contract tools — `describe_app` (routes + OpenAPI + schema
 * + collections) and `list_content_collections` — so Phase 1 still has no mutation path.
 */
export const READ_TOOL_ALLOWLIST = ["list_content_collections", "describe_app"] as const;

/**
 * The single read-only tool the Phase-1 in-preview overlay actually runs to inspect the
 * running app (the free-text prompt is not yet parsed into a tool choice, so one fixed
 * inspect tool answers every turn). `describe_app` is the richest contract tool AND it
 * DEGRADES gracefully on a content-less app (collections → `[]`, schema/OpenAPI → defaults,
 * `packages/mcp/src/resources.ts`), so the overlay lights up on ANY `lesto dev` app —
 * estate included, which ships no content peer. Typed as a MEMBER of {@link READ_TOOL_ALLOWLIST}
 * so the security boundary is compiler-enforced: the tool the overlay runs can never drift
 * off the allowlist.
 */
export const DEV_INSPECT_TOOL: (typeof READ_TOOL_ALLOWLIST)[number] = "describe_app";

/** One dev AI turn: the named dev tool to run and its redacted input. */
export interface AiTurn {
  /** The dev tool the turn wants to run — checked against {@link READ_TOOL_ALLOWLIST}. */
  readonly tool: string;

  /**
   * The input forwarded to the tool when the turn is allowed. Typed as the BRANDED
   * {@link RedactedContext} — not `unknown` — so the compiler forbids a caller from handing the
   * bridge a raw {@link import("./ai-redact").AiContextPayload}: the only value that satisfies
   * this type is {@link import("./ai-redact").redactContext}'s output, so a turn can never carry
   * a non-redacted payload out to the model (the ADR's redactor-bypass guard, enforced at
   * compile time). The bridge itself never inspects it.
   */
  readonly input?: RedactedContext;
}

/** The injected seams the bridge dispatches through — no `@lesto/mcp` import, only this shape. */
export interface AiBridgeDeps {
  /**
   * The dev MCP dispatch seam (ADR 0032), injected by `runDev` when the loopback dev MCP
   * server is up (the `generateUi?` injection discipline). Absent → every turn fails closed
   * with `CLI_DEV_MCP_UNAVAILABLE`. Only ever handed an already-allowlisted read-only turn.
   */
  readonly dispatchDevTool?: (turn: AiTurn) => Promise<unknown>;
}

/** The coded, fail-closed refusal both dead-ends raise — the overlay's inspect-only state. */
function devMcpUnavailable(tool: string, reason: string): CliError {
  return new CliError(
    "CLI_DEV_MCP_UNAVAILABLE",
    `The in-preview AI surface is inspect-only in Phase 1 (${reason}).`,
    { tool, reason },
  );
}

/**
 * Dispatch one AI turn through the fail-closed Phase-1 bridge.
 *
 * Refuses — with `CLI_DEV_MCP_UNAVAILABLE` — any turn whose tool is not on the positive
 * read-only {@link READ_TOOL_ALLOWLIST} (checked before, and independently of, the seam), and
 * any allowlisted turn whose `dispatchDevTool` seam is not wired. Only an allowlisted turn
 * with a live seam forwards, returning the tool's read-only result verbatim.
 */
export async function dispatchAiTurn(deps: AiBridgeDeps, turn: AiTurn): Promise<unknown> {
  // The positive allowlist is the boundary: refuse a non-allowlisted name outright, before the
  // seam is consulted, so a write-capable injected seam can never be reached by a write tool.
  if (!(READ_TOOL_ALLOWLIST as readonly string[]).includes(turn.tool)) {
    throw devMcpUnavailable(turn.tool, "not an allowlisted read-only tool");
  }

  // Allowlisted, but the ADR 0032 dev MCP server is not wired — fail closed, do not fall open.
  if (deps.dispatchDevTool === undefined) {
    throw devMcpUnavailable(turn.tool, "the dev MCP server is not available");
  }

  return deps.dispatchDevTool(turn);
}
