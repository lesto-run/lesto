/**
 * The wedge, in ONE place: the tiny deploy API + the `@lesto/mcp` Resource Server governance,
 * built on a transport-neutral `@lesto/web` app. BOTH substrates this example ships call this
 * exact function — `./app.ts` boots it on the Node kernel (`@lesto/runtime` + sqlite), and
 * `./worker.ts` runs the SAME app on Cloudflare Workers via `@lesto/cloudflare`'s
 * `toFetchHandler`. `createBearerAuthenticator` → `createMcpHttpHandlers` and the OpenAuth
 * verifier (`./verify.ts`) are byte-identical across both; only the SUBSTRATE differs (and how
 * `context.app` resolves — see the `app` param). That a Node server and an edge Worker share
 * this file verbatim is the whole point ADR 0039 is making: the governance is the battery, the
 * issuer is config, and the transport is a swap.
 */

import type { App } from "@lesto/kernel";
import { createBearerAuthenticator, createMcpHttpHandlers } from "@lesto/mcp";
import type { McpAuditRecord } from "@lesto/mcp";
import { lesto } from "@lesto/web";
import type { Lesto } from "@lesto/web";

import { createOpenAuthVerifier } from "./verify";

export interface Deployment {
  id: number;
  app: string;
  ref: string;
  at: string;
}

/** The scope vocabulary; `mcp:write` is the ceiling that unlocks the destructive tools. */
export const SCOPES = { read: "mcp:read", write: "mcp:write" } as const;

/** The issuer-and-policy wiring the governed app needs — identical for Node and the edge. */
export interface GovernanceOptions {
  /** The OpenAuth issuer URL (`iss`) the RS trusts. */
  issuer: string;

  /** The issuer's `jwks_uri` — where the RS fetches the signing keys. */
  jwksUrl: URL;

  /**
   * The OpenAuth client id. OpenAuth 0.4.x stamps `aud = clientID` and does NOT implement RFC
   * 8707 resource indicators, so the RS's `resource` MUST equal this (the battery's audience
   * guard is `aud === resource`) — the client identity doubles as the audience here. A token
   * minted for a DIFFERENT client is still refused (the confused-deputy guard holds; the test
   * proves it). For true per-resource audiences (one client, many resources), use an issuer
   * that stamps the resource into `aud` — only `./verify.ts` changes, not the battery.
   */
  clientID: string;

  /** The RS's public base URL — the RFC 9728 metadata pointer (`resource_metadata`) derives from it. */
  baseUrl: string;

  /** The browser origins allowed to reach the server (the DNS-rebinding allowlist). */
  allowedOrigins: readonly string[];

  /** Resolve a subject's roles — recorded on the principal + audit (the OCP-7 floor reads them). */
  rolesOf: (actor: string) => Iterable<string>;

  /**
   * The fetch the RS's JWKS request rides on (see {@link createOpenAuthVerifier}). Node and a
   * real cross-origin issuer omit it (global `fetch`); the edge demo passes a service-binding
   * fetch because same-account `workers.dev → workers.dev` subrequests are refused (CF 1042).
   */
  jwksFetch?: typeof fetch;
}

/** The governed `@lesto/web` app plus the in-memory state its handlers and audit close over. */
export interface GovernedApi {
  /** The transport-neutral app — `./app.ts` wraps it in the kernel, `./worker.ts` in `toFetchHandler`. */
  api: Lesto;

  /** The RS's resource identifier (= `clientID`, forced by OpenAuth's token shape). */
  resource: string;

  /** The MCP audit trail (every authenticated tool call lands here). */
  audit: McpAuditRecord[];

  /** The demo's deploy log — what the `handle_request` tool writes to via `POST /deployments`. */
  deployments: Deployment[];
}

/**
 * Build the deploy API and mount the `@lesto/mcp` governance on a fresh `@lesto/web` app.
 *
 * `app` is the {@link App} the MCP tools dispatch back INTO (`handle_request` drives a real
 * `POST /deployments` through it). It is read only at REQUEST time. The two substrates differ
 * here, and ONLY here:
 *   - Node passes a forward-reference to the BOOTED KERNEL app — `./app.ts` creates it with
 *     `await createApp` AFTER this returns, so the reference must be late-bound (migrations and
 *     durable schema apply before a tool call dispatches through it).
 *   - the edge omits `app`: there is no kernel, so MCP tool dispatch falls back into THIS `api`
 *     directly (self-dispatch). No forward-reference is needed — `api` is fully mounted by the
 *     time any request arrives.
 */
export function buildGovernedApi(options: GovernanceOptions, app?: App): GovernedApi {
  // Forced by OpenAuth's token shape (aud = clientID, no RFC 8707) — see `clientID` above.
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

  // Captured BEFORE the MCP routes are mounted, so `list_routes` reports the deploy API only,
  // not the MCP plumbing.
  const routes = api.routes();

  // Node redirects MCP tool dispatch through its booted kernel app; the edge (no `app`) dispatches
  // straight back into this `api`. `api` is fully built before any request, so this self-reference
  // needs no late binding (and there are no edge migrations to report).
  const contextApp: App = app ?? {
    handle: (method, path, requestOptions) => api.handle(method, path, requestOptions),
    migrationsApplied: [],
  };

  const handlers = createMcpHttpHandlers({
    context: {
      app: contextApp,
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
        ...(options.jwksFetch === undefined ? {} : { fetchJwks: options.jwksFetch }),
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

  return { api, resource, audit, deployments };
}

/** Demo `subject → roles`: the OpenAuth subject (an email) maps to a role. */
export function demoRolesOf(actor: string): string[] {
  return actor === "operator@example.com" ? ["operator"] : ["viewer"];
}
