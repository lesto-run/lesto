/**
 * `keel mcp` — serve the Keel MCP control plane over stdio.
 *
 * An AI agent speaks the Model Context Protocol to a Keel app: it lists routes,
 * reads content, and — in operator mode — writes content and drives the live
 * app. This is the command that stands that server up.
 *
 * Governance is the point (operability-dx #4 / blocker #12). The server defaults
 * to **read-only**: routes and content can be inspected, but nothing mutates and
 * no request is driven through the live app unless the operator passes
 * `--operator`. And every dispatch — success or refusal — is written to the
 * audit sink, so an operator can always see what an agent ran.
 *
 * Like `run`, the brain here is a pure, fully-injected core: a test hands it a
 * fake `loadApp`, a fake `createApp`, and a spy `startMcpServer` and asserts on
 * the context it built — no app boot, no stdio, no process. The bin wires the
 * real dependencies.
 *
 * The MCP protocol owns **stdout** (it is the transport), so the audit trail and
 * the startup banner go to **stderr** — they must never corrupt the wire.
 */

import { startMcpServer } from "@keel/mcp";
import type { KeelMcpContext, McpAuditRecord, McpMode } from "@keel/mcp";

import type { App, KeelAppConfig } from "@keel/kernel";

import { hasFlag } from "./flags";

/** The seams `keel mcp` depends on — all injected, never imported live. */
export interface McpDeps {
  /** Load the project's app config (the bin reads `keel.app.ts`; tests fake it). */
  loadApp: () => Promise<KeelAppConfig>;

  /** Boot the app so the control plane can drive its `handle` (the bin passes `@keel/kernel`'s). */
  createApp: (config: KeelAppConfig) => Promise<App>;

  /** Stand up the MCP server over stdio (the bin passes `@keel/mcp`'s `startMcpServer`). */
  startMcpServer: (context: KeelMcpContext) => Promise<void>;

  /**
   * Where an audit line goes. The bin wires this to `console.error` (stderr), so
   * the audit trail never corrupts the MCP protocol on stdout. Tests capture it.
   */
  audit: (line: string) => void;

  /** Where the startup banner goes — stderr in the bin, for the same reason. */
  log: (line: string) => void;
}

/**
 * Render one audit record as a single structured line.
 *
 * One stable, greppable shape: the tool, its outcome, the input hash (never the
 * input), and the duration. An operator reads the trail like prose; a machine
 * splits on the ` ` and the `=`.
 */
function auditLine(record: McpAuditRecord): string {
  return `mcp.audit tool=${record.tool} outcome=${record.outcome} hash=${record.inputHash} duration_ms=${record.durationMs}`;
}

/**
 * Serve the Keel MCP control plane.
 *
 * Boots the app, assembles a {@link KeelMcpContext} — its routes, the content
 * database (the app's own SQL handle, so the content write tools have a store),
 * the mode from `--operator`, and a mandatory audit sink — then hands it to
 * `startMcpServer`. Resolves only when the transport closes; the bin keeps the
 * process alive until then.
 *
 * `--operator` unlocks the destructive tools (content writes, `handle_request`);
 * absent, the safe read-only floor. The banner names the active mode so an
 * operator is never surprised about what the agent can do.
 */
export async function runMcp(args: readonly string[], deps: McpDeps): Promise<number> {
  const config = await deps.loadApp();

  const app = await deps.createApp(config);

  // Operator mode is the deliberate, named escalation; absent, the read-only
  // floor — so a forgotten flag fails closed to the safe surface.
  const mode: McpMode = hasFlag(args, "operator") ? "operator" : "read-only";

  const context: KeelMcpContext = {
    app,
    routes: config.app.routes(),

    mode,

    // Every dispatch lands one structured line on the audit sink. This is the
    // governance the control plane exists to provide — there is no un-audited path.
    audit: (record) => deps.audit(auditLine(record)),

    // The app's own database is the content store the write tools mutate; in
    // read-only mode they are gated before they ever reach it.
    contentDb: config.db,
  };

  deps.log(`keel mcp: serving over stdio in ${mode} mode`);

  await deps.startMcpServer(context);

  return 0;
}

/** The real `startMcpServer`, re-exported so the bin's wiring stays a one-liner. */
export { startMcpServer };
