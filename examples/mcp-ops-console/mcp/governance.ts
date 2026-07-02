/**
 * The wedge, in ONE place: the multi-domain ops console + the `@lesto/mcp` Resource Server
 * governance, built on a transport-neutral `@lesto/web` app. BOTH substrates this example ships
 * call this exact function — `./app.ts` boots it on the Node kernel (`@lesto/runtime` + sqlite),
 * and `./worker.ts` runs the SAME app on Cloudflare Workers via `@lesto/cloudflare`'s
 * `toFetchHandler`. `createBearerAuthenticator` → `createMcpHttpHandlers` and the OpenAuth verifier
 * (`./verify.ts`) are byte-identical across both; only the SUBSTRATE differs (and how `context.app`
 * resolves — see the `app` param). That a Node server and an edge Worker share this file verbatim
 * is the whole point ADR 0039 is making: the governance is the battery, the issuer is config, and
 * the transport is a swap.
 *
 * The app's surface is richer than the sibling's single dataset: THREE linked domains —
 * services, incidents, deploys (../mcp/ops.ts) — so the agent chains several tools into one real
 * incident-response task. The destructive writes (`POST /incidents`, `POST /incidents/:id/notes`,
 * `POST /deploys`) are reached only through the MCP `handle_request` tool, so the OpenAuth scopes
 * gate them exactly as designed: an SRE (`mcp:write`) drives the console, a viewer (`mcp:read`) is
 * refused every write, an unauthenticated agent never connects.
 */

import { definePolicy } from "@lesto/authz";
import type { App } from "@lesto/kernel";
import { createBearerAuthenticator, createMcpHttpHandlers } from "@lesto/mcp";
import type { McpAuditRecord } from "@lesto/mcp";
import { lesto } from "@lesto/web";
import type { Lesto } from "@lesto/web";

import { declareIncident, requestDeploy, seedOps, updateIncident } from "./ops";
import type { Incident, OpsStore } from "./ops";
import { createOpenAuthVerifier } from "./verify";

/** The scope vocabulary; `mcp:write` is the ceiling that unlocks the destructive tools today. */
export const SCOPES = { read: "mcp:read", write: "mcp:write" } as const;

/**
 * The ops roles this console understands. Scope governance enforces the read/write CEILING today
 * (a viewer can't write at all); the per-tool ROLE FLOOR is the forward-looking half — see
 * {@link toolPolicy} and {@link demoRolesOf}.
 */
export const ROLES = {
  sre: "sre",
  oncall: "oncall",
  viewer: "viewer",
  // An exec/stakeholder handed a broad token (mcp:read mcp:write) but who should NOT operate the
  // console — the over-scoped identity the role floor exists to bound (see {@link opsPolicy}).
  stakeholder: "stakeholder",
} as const;

/**
 * The permission the console's WRITE tool demands — the OCP-7 role floor, now WIRED on the
 * dispatch path. Every write flows through the one destructive MCP tool, `handle_request`, which
 * {@link buildGovernedApi} maps to this permission via `toolPermissions`. So the floor intersects
 * the scope ceiling: `handle_request` needs the `mcp:write` scope AND `console:operate`. An
 * over-scoped token is therefore still bounded by the subject's ROLE.
 */
const OPERATE = "console:operate";

/**
 * The `@lesto/authz` policy the OCP-7 floor consults. Only `sre`/`oncall` may operate the console;
 * a `viewer` (no write scope) and a `stakeholder` (write scope but no `console:operate`) are both
 * refused the write tool — the `stakeholder` BY ROLE, demonstrating the floor catching a token the
 * scope ceiling alone would let through. Passed to `createMcpHttpHandlers` in {@link buildGovernedApi}.
 */
export const opsPolicy = definePolicy({
  roles: [ROLES.sre, ROLES.oncall, ROLES.viewer, ROLES.stakeholder],
  can: { [OPERATE]: [ROLES.sre, ROLES.oncall] },
});

/**
 * The per-ROUTE split (e.g. `oncall` may annotate incidents but not gate deploys) the console
 * WOULD enforce once the floor is ROUTE-aware. The TOOL-level floor is wired TODAY (see
 * {@link opsPolicy}: `handle_request` → `console:operate`); per-route gating needs domain-specific
 * MCP tools (one tool per action) instead of the generic `handle_request` — a follow-up. This
 * table documents that future split and is a test fixture; it is not consulted on the live path.
 */
export const toolPolicy: Record<string, readonly string[]> = {
  list_routes: [ROLES.sre, ROLES.oncall, ROLES.viewer],
  declare_incident: [ROLES.sre, ROLES.oncall],
  annotate_incident: [ROLES.sre, ROLES.oncall],
  gate_deploy: [ROLES.sre],
};

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
   * proves it). For true per-resource audiences (one client, many resources), use an issuer that
   * stamps the resource into `aud` — only `./verify.ts` changes, not the battery.
   */
  clientID: string;

  /** The RS's public base URL — the RFC 9728 metadata pointer (`resource_metadata`) derives from it. */
  baseUrl: string;

  /** The browser origins allowed to reach the server (the DNS-rebinding allowlist). */
  allowedOrigins: readonly string[];

  /** Resolve a subject's roles — recorded on the principal + audit (the OCP-7 floor reads them). */
  rolesOf: (actor: string) => Iterable<string>;

  /**
   * The fetch the RS's JWKS request rides on (see {@link createOpenAuthVerifier}). Node and a real
   * cross-origin issuer omit it (global `fetch`); the edge demo passes a service-binding fetch
   * because same-account `workers.dev → workers.dev` subrequests are refused (CF 1042).
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

  /** The ops console's state — what the `handle_request` tool reads and writes through the routes. */
  store: OpsStore;
}

/** The shape `POST /incidents` accepts (validated defensively; the app never trusts the wire). */
interface DeclareBody {
  title?: unknown;
  severity?: unknown;
  services?: unknown;
}

/** Coerce a wire `severity` to the enum, defaulting to the least-urgent. */
function asSeverity(value: unknown): Incident["severity"] {
  return value === "sev1" || value === "sev2" ? value : "sev3";
}

/**
 * Build the ops console and mount the `@lesto/mcp` governance on a fresh `@lesto/web` app.
 *
 * `app` is the {@link App} the MCP tools dispatch back INTO (`handle_request` drives a real
 * `POST /incidents` etc. through it). It is read only at REQUEST time. The two substrates differ
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

  const store = seedOps();
  const audit: McpAuditRecord[] = [];

  // The console: in-memory reads (services / incidents / deploys) + the destructive writes. Every
  // route is reached through the MCP `handle_request` tool, so the OpenAuth scopes gate them — an
  // SRE (mcp:write) drives the console, a viewer (mcp:read) is refused the writes, an
  // unauthenticated agent never connects. The cross-entity deploy-freeze rule lives in ../mcp/ops.ts.
  const api = lesto()
    .get("/health", (c) => c.json({ ok: true }))
    // ── Services ──────────────────────────────────────────────────────────────
    .get("/services", (c) => c.json({ services: store.services }))
    .get("/services/:id", (c) => {
      const svc = store.services.find((s) => s.id === c.param("id"));

      return svc === undefined ? c.json({ error: "no such service" }, 404) : c.json(svc);
    })
    // ── Incidents (GET reads; POST is the operator-only write) ─────────────────
    .get("/incidents", (c) => {
      const status = c.query("status");
      const incidents =
        status === undefined ? store.incidents : store.incidents.filter((i) => i.status === status);

      return c.json({ incidents });
    })
    .get("/incidents/:id", (c) => {
      const incident = store.incidents.find((i) => i.id === Number(c.param("id")));

      return incident === undefined ? c.json({ error: "no such incident" }, 404) : c.json(incident);
    })
    .post("/incidents", (c) => {
      const body = (c.req.body ?? {}) as DeclareBody;
      const services = Array.isArray(body.services) ? body.services.map(String) : [];
      const incident = declareIncident(store, {
        title: String(body.title ?? "untitled incident"),
        severity: asSeverity(body.severity),
        services,
        // The MCP principal isn't on the route context here; the demo attributes the write to the
        // role's archetype actor. (A production app would thread the authenticated subject through.)
        actor: "sre@ops.example.com",
      });

      return c.json({ incident }, 201);
    })
    .post("/incidents/:id/notes", (c) => {
      const body = (c.req.body ?? {}) as { note?: unknown; status?: unknown };
      const status =
        body.status === "open" || body.status === "mitigated" || body.status === "resolved"
          ? body.status
          : undefined;
      const incident = updateIncident(store, Number(c.param("id")), {
        note: String(body.note ?? ""),
        actor: "sre@ops.example.com",
        ...(status === undefined ? {} : { status }),
      });

      return incident === undefined
        ? c.json({ error: "no such incident" }, 404)
        : c.json({ incident }, 201);
    })
    // ── Deploys (GET reads; POST requests a deploy — GATED by active incidents) ─
    .get("/deploys", (c) => c.json({ deploys: store.deploys }))
    .post("/deploys", (c) => {
      const body = (c.req.body ?? {}) as { service?: unknown; version?: unknown };
      const deploy = requestDeploy(store, {
        service: String(body.service ?? ""),
        version: String(body.version ?? "0.0.0"),
      });

      // A blocked deploy is a successful, recorded decision (201) — the freeze is the feature,
      // not an error. The agent reads `status: "blocked"` and knows to resolve the incident first.
      return c.json({ deploy }, 201);
    });

  // Captured BEFORE the MCP routes are mounted, so `list_routes` reports the console only, not the
  // MCP plumbing.
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
      audit: (record: McpAuditRecord) => {
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
    // OCP-7 role floor (now wired): the write tool needs `console:operate` ON TOP of `mcp:write`,
    // so a subject with the scope but not the role (the stakeholder) is refused — a 403 floor.
    policy: opsPolicy,
    toolPermissions: { handle_request: OPERATE },
  });

  api
    .get("/.well-known/oauth-protected-resource", handlers.metadata)
    .post("/mcp", handlers.rpc)
    .get("/mcp", handlers.noStream);

  return { api, resource, audit, store };
}

/**
 * Demo `subject → roles`: the OpenAuth subject (an email) maps to its ops role. Shaped so the
 * forward-looking per-tool floor ({@link toolPolicy}) can read `sre` / `oncall` / `viewer`
 * straight off the principal; today only the scope ceiling is consulted, so `sre` and `oncall`
 * are equivalent at runtime (both write).
 */
export function demoRolesOf(actor: string): string[] {
  if (actor === "sre@ops.example.com") return [ROLES.sre];
  if (actor === "oncall@ops.example.com") return [ROLES.oncall];
  if (actor === "stakeholder@ops.example.com") return [ROLES.stakeholder];

  return [ROLES.viewer];
}
