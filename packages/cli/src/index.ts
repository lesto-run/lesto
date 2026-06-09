/**
 * @keel/cli — the `keel` command-line tool.
 *
 *   const code = await run(["routes"], {
 *     loadApp: () => import("./keel.app").then((m) => m.default),
 *     serve,
 *     out: console.log,
 *   });
 *
 * The brain is a pure, fully-injectable `run` (here); the executable `bin.ts`
 * is the thin wiring that builds the real dependencies and keeps the process
 * alive for long-running commands.
 */

export type { AppConfig } from "@keel/kernel";

export { run } from "./run";
export type { CliDeps } from "./run";

export { parsePort, parseStringFlag } from "./flags";
export type { PortFlag } from "./flags";

export { CliError, KeelError } from "./errors";
export type { CliErrorCode } from "./errors";
