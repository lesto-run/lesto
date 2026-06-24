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

export { parseServeLimit, run } from "./run";
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

export { runMcp } from "./mcp";
export type { McpDeps } from "./mcp";

export { runOpenApi } from "./openapi";
export type { OpenApiDeps } from "./openapi";

export { parseField, resourceName, runGenerate } from "./generate";
export type { GenerateDeps, GenerateIO, GeneratedFile, ResourceName } from "./generate";

export { hasFlag, parsePort, parseStringFlag } from "./flags";
export type { PortFlag } from "./flags";

export { CliError, LestoError } from "./errors";
export type { CliErrorCode } from "./errors";
