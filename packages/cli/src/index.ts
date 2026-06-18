/**
 * @volo/cli — the `volo` command-line tool.
 *
 *   const code = await run(["routes"], {
 *     loadApp: () => import("./volo.app").then((m) => m.default),
 *     serve,
 *     out: console.log,
 *   });
 *
 * The brain is a pure, fully-injectable `run` (here); the executable `bin.ts`
 * is the thin wiring that builds the real dependencies and keeps the process
 * alive for long-running commands.
 */

export { run } from "./run";
export type { CliDeps, ReleaseTarget } from "./run";

export { runMcp } from "./mcp";
export type { McpDeps } from "./mcp";

export { runOpenApi } from "./openapi";
export type { OpenApiDeps } from "./openapi";

export { hasFlag, parsePort, parseStringFlag } from "./flags";
export type { PortFlag } from "./flags";

export { CliError, VoloError } from "./errors";
export type { CliErrorCode } from "./errors";
