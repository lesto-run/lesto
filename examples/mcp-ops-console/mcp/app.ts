/**
 * The Lesto MCP Resource Server on the NODE substrate — `@lesto/runtime`'s `serve` over a real
 * sqlite handle. The governance itself lives in `./governance.ts` and is shared verbatim with the
 * Cloudflare Worker (`./worker.ts`); this file only boots that governed app on the kernel.
 *
 * The wedge's whole point is that `buildGovernedApi` is untouched here — `createBearerAuthenticator`
 * + `createMcpHttpHandlers` validate a REAL OpenAuth token (../mcp/verify.ts) the same way on Node
 * and on the edge. Pointing the RS at a different issuer is config, not code; running it on a
 * different transport is a substrate swap, not a rewrite.
 *
 * The app's own surface is an ops console: the app's real actions are FIRST-CLASS governed MCP tools
 * (`declare_incident` / `annotate_incident` / `gate_deploy` writes, `list_services` / `list_deploys`
 * reads, ADR 0043), the generic `handle_request` is OMITTED for least privilege, and `list_routes`
 * is read-only — so the OpenAuth scopes (`mcp:read` vs `mcp:read mcp:write`) AND the per-tool role
 * floor gate exactly as designed.
 */

import { createApp } from "@lesto/kernel";
import type { App, KernelDatabase } from "@lesto/kernel";
import type { McpAuditRecord } from "@lesto/mcp";

import { buildGovernedApi, PERMISSIONS, ROLES, SCOPES, demoRolesOf, opsPolicy } from "./governance";
import type { GovernanceOptions } from "./governance";
import type { OpsStore } from "./ops";

// Re-exported so the example's tests and entrypoints keep importing them from `./app`.
export { PERMISSIONS, ROLES, SCOPES, demoRolesOf, opsPolicy };

export interface BuildRsOptions extends GovernanceOptions {
  /** The kernel database handle (from `@lesto/runtime`'s `openSqlite`). */
  handle: KernelDatabase;
}

export interface BootedRs {
  app: App;
  resource: string;
  audit: McpAuditRecord[];
  store: OpsStore;
}

export async function buildRs(options: BuildRsOptions): Promise<BootedRs> {
  // Forward reference: the MCP handlers read `context.app` only at request time, by which point
  // the kernel app has booted. The shared `buildGovernedApi` dispatches MCP tool calls back
  // through this booted app (migrations applied, durable schema installed).
  let booted: App | undefined;
  const appRef: App = {
    handle: (method, path, requestOptions) => {
      if (booted === undefined) throw new Error("MCP context used before the app booted");

      return booted.handle(method, path, requestOptions);
    },
    get migrationsApplied(): readonly string[] {
      if (booted === undefined) throw new Error("MCP context used before the app booted");

      return booted.migrationsApplied;
    },
  };

  const governed = buildGovernedApi(options, appRef);

  booted = await createApp({ db: options.handle, app: governed.api });

  return {
    app: booted,
    resource: governed.resource,
    audit: governed.audit,
    store: governed.store,
  };
}
