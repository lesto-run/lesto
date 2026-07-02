/**
 * Assemble an authenticated remote MCP server over a tiny "production" app.
 *
 * The shape MA-6 exists to prove (ADR 0028 Phase 3b / ADR 0039): a real, runnable
 * Lesto app that an agent reaches over HTTP — but only through a validated OAuth bearer
 * token. The app's own surface is a miniature deploy API (`/deployments`); the MCP
 * Resource Server is mounted alongside it and is the *governed front door* an agent uses
 * to inspect and drive that app.
 *
 * The wiring, end to end:
 *   - {@link createJwksVerifier} validates a token against the issuer's JWKS (the demo
 *     IdP here; an external IdP in production) — the injected, AS-agnostic verify seam.
 *   - {@link createBearerAuthenticator} binds a valid token's subject to a principal AND
 *     enforces the audience no-passthrough guard (a token minted for another resource is
 *     refused — the confused-deputy guard).
 *   - {@link createMcpHttpHandlers} turns that into two `@lesto/web` handlers the app
 *     mounts itself (no `kernel → mcp` edge): the RFC 9728 metadata document and the
 *     Streamable-HTTP RPC endpoint, which gates every request (Origin → bearer → scope
 *     ceiling) before a tool runs.
 *
 * The two capabilities under test:
 *   - **The scope ceiling.** A `mcp:read` token floors to `read-only` mode: `list_routes`
 *     works, but the destructive `handle_request` is refused with a `403`
 *     `insufficient_scope` BEFORE it reaches the app. An `mcp:read mcp:write` token unlocks
 *     `operator`, so the same call drives a real `POST /deployments`.
 *   - **The audit trail.** Every dispatch — allowed or refused — records one
 *     {@link McpAuditRecord} (tool, outcome, the resolved `actor`), so an operator can
 *     always see which agent ran what. There is no un-audited path to a tool.
 */

import { createApp } from "@lesto/kernel";
import type { App, KernelDatabase } from "@lesto/kernel";
import { createBearerAuthenticator, createMcpHttpHandlers } from "@lesto/mcp";
import type { McpAuditRecord } from "@lesto/mcp";
import { lesto } from "@lesto/web";
import type { JSONWebKeySet } from "jose";

import { createJwksVerifier } from "./verify";

/** One deploy the mini app records — the visible effect of an operator agent's `handle_request`. */
export interface Deployment {
  id: number;
  app: string;
  ref: string;
  at: string;
}

/** The OAuth scope vocabulary this server understands; `mcp:write` is the ceiling that unlocks writes. */
export const SCOPES = { read: "mcp:read", write: "mcp:write" } as const;

/** What {@link buildApp} needs to stand up the server. */
export interface BuildOptions {
  /** The kernel database handle (from `@lesto/runtime`'s `openSqlite`). */
  handle: KernelDatabase;

  /** The trusted issuer (`iss`) — the demo IdP, or your external IdP in production. */
  issuer: string;

  /** The issuer's signing keys: the in-process JWKS (demo) or its `jwks_uri` `URL` (production). */
  jwks: JSONWebKeySet | URL;

  /**
   * The server's public base URL (e.g. `http://127.0.0.1:3000`). The RS's resource
   * identifier (`${baseUrl}/mcp`, the token audience) and its PRM URL derive from it, so
   * the advertised metadata URL always matches the path the app mounts it at.
   */
  baseUrl: string;

  /** Resolve a subject's roles — recorded on the principal + audit; the OCP-7 policy floor will read them. */
  rolesOf: (actor: string) => Iterable<string>;

  /** The browser origins allowed to reach the server (the DNS-rebinding allowlist). */
  allowedOrigins: readonly string[];
}

/** What {@link buildApp} returns: the booted app plus the handles run.ts / serve / tests need. */
export interface Booted {
  app: App;

  /** The business routes `list_routes` surfaces (the MCP plumbing is deliberately not listed). */
  routes: readonly { method: string; pattern: string }[];

  /** This RS's resource identifier — the audience a token must carry (`${baseUrl}/mcp`). */
  resource: string;

  /** The absolute PRM URL clients discover the issuer through. */
  resourceMetadataUrl: string;

  /** The live MCP audit trail — one record per dispatch, allowed or refused. */
  audit: McpAuditRecord[];

  /** The deploys the mini app has recorded — what an operator agent's writes produce. */
  deployments: Deployment[];
}

/**
 * Boot the server: build the mini deploy app, wire the MCP Resource Server over it, and
 * mount both on one `lesto()` app run through the kernel.
 */
export async function buildApp(options: BuildOptions): Promise<Booted> {
  const resource = `${options.baseUrl}/mcp`;
  const resourceMetadataUrl = `${options.baseUrl}/.well-known/oauth-protected-resource`;

  // The "production" state the agent operates: an in-memory list of deploys.
  const deployments: Deployment[] = [];

  // The MCP audit sink: every dispatch lands one record here, so the governance trail is
  // queryable (run.ts prints it; the test asserts on it).
  const audit: McpAuditRecord[] = [];

  // The app's own surface — a miniature deploy API. `POST /deployments` is the destructive
  // op an operator agent drives through `handle_request`; the others are safe reads.
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

  // Capture the business routes BEFORE mounting the MCP endpoints, so `list_routes` shows
  // the app the agent operates — not the auth plumbing it operates it through.
  const routes = api.routes();

  // `createMcpHttpHandlers` needs the booted `App` (for `handle_request`), but the app is
  // built FROM these routes — a forward reference. The handlers read `context.app` only at
  // request time, so a proxy that delegates to the (by-then) booted app closes the loop
  // without a `kernel → mcp` edge.
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
    // Validate the token (signature/issuer/expiry), then bind its subject to a principal
    // and enforce the audience names THIS resource.
    authenticate: createBearerAuthenticator({
      verifyAccessToken: createJwksVerifier({ issuer: options.issuer, jwks: options.jwks }),
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

  // Mount the RS the app owns: the PRM discovery doc (GET) and the MCP endpoint (POST).
  api.get("/.well-known/oauth-protected-resource", handlers.metadata).post("/mcp", handlers.rpc);

  // A real MCP client (StreamableHTTPClientTransport) probes GET /mcp for an optional
  // server→client SSE stream; this stateless JSON server offers none → 405 (`Allow: POST`),
  // the clean "no SSE here" the client reads instead of a 404 it surfaces as a transport error.
  api.get("/mcp", handlers.noStream);

  booted = await createApp({ db: options.handle, app: api });

  return { app: booted, routes, resource, resourceMetadataUrl, audit, deployments };
}

/**
 * The demo's `subject → roles` map. A real server reads this from `@lesto/identity`'s
 * `rolesOf`; here a small table stands in. Roles ride the principal + the audit trail;
 * the per-tool policy floor that consults them lands with OCP-7.
 */
export function demoRolesOf(actor: string): string[] {
  const roles: Record<string, string[]> = {
    "operator@example.com": ["operator"],
    "viewer@example.com": ["viewer"],
  };

  return roles[actor] ?? [];
}
