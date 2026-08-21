/**
 * @lesto/cli — the `lesto` command-line tool.
 *
 *   const code = await run(["routes"], {
 *     loadApp: () => import("./lesto.app").then((m) => m.default),
 *     serve,
 *     out: console.log,
 *   });
 *
 * The brain is a pure, fully-injectable `run` (here); the executable `bin.ts`
 * is the thin wiring that builds the real dependencies and keeps the process
 * alive for long-running commands.
 */

export { declaresIslandDevPeer, parseServeLimit, run } from "./run";
export type {
  BuildHook,
  BuildHookContext,
  BuiltSite,
  CliDeps,
  DevError,
  DevErrorSource,
  LiveReload,
  ReleaseTarget,
  ServeLimitsEnv,
} from "./run";

// The dev-state ring the `dev` command's MCP control plane reads (ADR 0032 Phase 1).
// Exported so an app that drives `run`'s dev path itself — the estate dogfood
// (L-cfd434f4) — can build the same bounded ring the bin wires, rather than reaching
// into an internal module. `createDevState` is the only way to satisfy `CliDeps.devState`.
export { createDevState, DEFAULT_DEV_RING_CAPACITY } from "./dev-state";
export type { DevState, DevStateReader, DevStateWriter } from "./dev-state";

// The TYPES of the bounded TRACE ring the dev-state ring composes (ADR 0048 Phase
// 0.2) — reachable through `DevState`, so a caller that names one needs them. The
// ring's own constructor and constants stay internal until something outside the
// CLI builds a ring of its own; `createDevState` is the supported way in.
export type {
  TraceLookup,
  TraceRingOptions,
  TraceRingReader,
  TraceRingWriter,
  TraceSelector,
} from "./trace-ring";

// The in-preview AI overlay client string (ADR 0033 Phase 1). Exported for the SAME
// reason as `createDevState`: the estate overlay dogfood (L-d43dde63) drives `run`'s dev
// path itself and needs the EXACT script the bin bakes into the `aiOverlay` seam, so it
// paints the real overlay rather than reaching into an internal module or asserting a
// sentinel. Dev-only by construction — `runDev` is the only code path that injects it.
export { aiOverlayClientScript } from "./ai-overlay";
export type { AiOverlayOptions } from "./ai-overlay";

export { runMcp } from "./mcp";
export type { McpDeps } from "./mcp";

export { runOpenApi } from "./openapi";
export type { OpenApiDeps } from "./openapi";

export { parseField, resourceName, runGenerate } from "./generate";
export type { GenerateDeps, GenerateIO, GeneratedFile, ResourceName } from "./generate";

export { runAdd } from "./add";
export type { AddDeps, AddIO } from "./add";

export { hasFlag, parsePort, parseStringFlag } from "./flags";
export type { PortFlag } from "./flags";

export { CliError, LestoError } from "./errors";
export type { CliErrorCode } from "./errors";
