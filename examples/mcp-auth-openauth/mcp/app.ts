/**
 * The Lesto MCP Resource Server — the SAME `@lesto/mcp` battery as the sibling
 * `examples/mcp-server`, with one thing swapped: the `VerifyAccessToken` seam now validates
 * a REAL OpenAuth-issued token (../mcp/verify.ts) instead of the hermetic stand-in. That is
 * the wedge's whole point — `createBearerAuthenticator` + `createMcpHttpHandlers` are
 * untouched; pointing the RS at a different issuer is config, not code.
 *
 * The app's own surface is a tiny deploy API; `handle_request` (operator-only) drives a real
 * `POST /deployments`, `list_routes` is read-only — so the OpenAuth scopes (`mcp:read` vs
 * `mcp:read mcp:write`, carried in the token's `properties.scopes`) gate exactly as before.
 *
 * The RS wiring here deliberately mirrors `examples/mcp-server/src/app.ts` rather than sharing
 * a factory: each gallery example stays self-contained and readable on its own. The ONLY real
 * difference is the verifier (../mcp/verify.ts) and `resource` — that is the point being made.
 */

import { createApp } from "@lesto/kernel";
import type { App, KernelDatabase } from "@lesto/kernel";
import { createBearerAuthenticator, createMcpHttpHandlers } from "@lesto/mcp";
import type { McpAuditRecord } from "@lesto/mcp";
import { lesto } from "@lesto/web";

import { createOpenAuthVerifier } from "./verify";

export interface Deployment {
  id: number;
  app: string;
  ref: string;
  at: string;
}

/** The scope vocabulary; `mcp:write` is the ceiling that unlocks the destructive tools. */
export const SCOPES = { read: "mcp:read", write: "mcp:write" } as const;

export interface BuildRsOptions {
  /** The kernel database handle (from `@lesto/runtime`'s `openSqlite`). */
  handle: KernelDatabase;

  /** The OpenAuth issuer URL (`iss`) the RS trusts. */
  issuer: string;

  /** The issuer's `jwks_uri` — where the RS fetches the signing keys. */
  jwksUrl: URL;

  /**
   * The OpenAuth client id. OpenAuth 0.4.x stamps `aud = clientID` and does NOT implement RFC
   * 8707 resource indicators, so the RS's `resource` MUST equal this (the battery's audience
   * guard is `aud === resource`) — i.e. the client identity doubles as the audience here. A
   * token minted for a DIFFERENT client is still refused (the confused-deputy guard holds; the
   * test proves it). For true per-resource audiences (one client, many resources), use an issuer
   * that stamps the resource into `aud`/a `resource` claim — only this verifier changes, not the
   * battery.
   */
  clientID: string;

  /** The RS's public base URL — the PRM document URL derives from it. */
  baseUrl: string;

  /** The browser origins allowed to reach the server (the DNS-rebinding allowlist). */
  allowedOrigins: readonly string[];

  /** Resolve a subject's roles — recorded on the principal + audit (the OCP-7 floor reads them). */
  rolesOf: (actor: string) => Iterable<string>;
}

export interface BootedRs {
  app: App;
  resource: string;
  audit: McpAuditRecord[];
  deployments: Deployment[];
}

export async function buildRs(options: BuildRsOptions): Promise<BootedRs> {
  // Forced by OpenAuth's token shape (aud = clientID, no RFC 8707) — see the field doc above.
  const resource = options.clientID;
  const resourceMetadataUrl = `${options.baseUrl}/.well-known/oauth-protected-resource`;

  const deployments: Deployment[] = [];
  const audit: McpAuditRecord[] = [];

  const api = lesto()
    .get("/health", (c) => c.json({ ok: true }))
    .get("/deployments", (c) => c.json({ deployments }))
    .post("/deployments", (c) => {
      const input = (c.req.body ?? {}) as { app?: unknown; ref?: unknown };
      const deployment: Deployment = {
        id: deployments.length + 1,
        app: String(input.app ?? "unknown"),
        ref: String(input.ref ?? "main"),
        at: new Date().toISOString(),
      };
      deployments.push(deployment);

      return c.json({ deployment }, 201);
    });

  const routes = api.routes();

  // Forward reference: the MCP handlers read `context.app` only at request time, by which
  // point the app has booted (see the sibling example for the rationale).
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

  const handlers = createMcpHttpHandlers({
    context: {
      app: appRef,
      routes,
      audit: (record) => {
        audit.push(record);
      },
    },
    // The ONLY issuer-specific wiring: validate a real OpenAuth token via its JWKS.
    authenticate: createBearerAuthenticator({
      verifyAccessToken: createOpenAuthVerifier({
        issuer: options.issuer,
        jwksUrl: options.jwksUrl,
      }),
      resource,
      rolesOf: options.rolesOf,
    }),
    resource,
    authorizationServers: [options.issuer],
    scopesSupported: [SCOPES.read, SCOPES.write],
    writeScope: SCOPES.write,
    allowedOrigins: options.allowedOrigins,
    resourceMetadataUrl,
  });

  api
    .get("/.well-known/oauth-protected-resource", handlers.metadata)
    .post("/mcp", handlers.rpc)
    .get("/mcp", () => ({ status: 405, headers: { allow: "POST" }, body: "" }));

  booted = await createApp({ db: options.handle, app: api });

  return { app: booted, resource, audit, deployments };
}

/** Demo `subject → roles`: the OpenAuth subject (an email) maps to a role. */
export function demoRolesOf(actor: string): string[] {
  return actor === "operator@example.com" ? ["operator"] : ["viewer"];
}
