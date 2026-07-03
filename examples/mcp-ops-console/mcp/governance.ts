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
 * services, incidents, deploys (../mcp/ops.ts) — so an agent chains several tools into one real
 * incident-response task. Each real action is a FIRST-CLASS, named, typed MCP tool that OWNS its
 * per-tool policy floor (ADR 0043): `declare_incident` / `annotate_incident` / `gate_deploy` are
 * the governed writes, `list_services` / `list_deploys` the reads. The generic `handle_request` is
 * OMITTED (`omitTools`) — the least-privilege production posture — so an agent can perform exactly
 * the declared actions and nothing else, and the floor discriminates them: `oncall` may declare and
 * annotate but NOT gate a deploy, the split that was unenforceable under one opaque `handle_request`.
 */

import { z } from "zod";

import { definePolicy } from "@lesto/authz";
import type { App } from "@lesto/kernel";
import { createBearerAuthenticator, createMcpHttpHandlers, defineDomainTool } from "@lesto/mcp";
import type { LestoDomainTool, McpAuditRecord } from "@lesto/mcp";
import { lesto } from "@lesto/web";
import type { Lesto } from "@lesto/web";

import { declareIncident, requestDeploy, seedOps, updateIncident } from "./ops";
import type { Incident, OpsStore } from "./ops";
import { createOpenAuthVerifier } from "./verify";

/** The scope vocabulary; `mcp:write` is the ceiling that unlocks the destructive domain tools. */
export const SCOPES = { read: "mcp:read", write: "mcp:write" } as const;

/**
 * The ops roles this console understands. The scope ceiling enforces the read/write CEILING (a
 * viewer can't write at all); the per-tool ROLE FLOOR discriminates the writes — see
 * {@link opsPolicy} and {@link demoRolesOf}.
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
 * The per-ACTION permissions each governed domain tool OWNS (ADR 0043). One permission per real
 * action — the granularity the generic `handle_request` collapsed onto a single `console:operate`.
 */
export const PERMISSIONS = {
  declare: "incident:declare",
  annotate: "incident:annotate",
  gate: "deploy:gate",
} as const;

/**
 * The `@lesto/authz` policy the OCP-7 floor consults, now PER-ACTION (ADR 0043). `sre` and `oncall`
 * may declare and annotate incidents, but ONLY `sre` may gate a deploy. A `viewer` (no write scope)
 * is refused every write by the scope ceiling; a `stakeholder` (write scope but no operating role)
 * by the floor. The `oncall`-can-declare-but-not-gate-deploy row is the exact assertion that was
 * impossible under the single generic `handle_request` — now real, enforced on both substrates.
 */
export const opsPolicy = definePolicy({
  roles: [ROLES.sre, ROLES.oncall, ROLES.viewer, ROLES.stakeholder],
  can: {
    [PERMISSIONS.declare]: [ROLES.sre, ROLES.oncall],
    [PERMISSIONS.annotate]: [ROLES.sre, ROLES.oncall],
    [PERMISSIONS.gate]: [ROLES.sre],
  },
});

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

  /** The MCP audit trail (every authenticated tool call lands here, naming the DOMAIN action). */
  audit: McpAuditRecord[];

  /** The ops console's state — what the domain tools read and write. */
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
 * The app's real actions as first-class, governed domain tools (ADR 0043), bound to `store` and the
 * resolved principal. Each write OWNS its per-tool floor via `requires.permission`, attributes to
 * `ctx.principal.actor` (no hard-coded actor), and RETURNS the resulting entity so an agent observes
 * the effect (a declared incident freezing the next deploy) without a separate read. The reads carry
 * no floor — the scope ceiling (a read-scoped token) governs them, so a `viewer` reads but never writes.
 */
function opsDomainTools(store: OpsStore): LestoDomainTool[] {
  const listServices = defineDomainTool({
    name: "list_services",
    description: "List the fleet's services with their current health.",
    input: z.object({}),
    destructive: false,
    handler: () => Promise.resolve({ services: store.services }),
  });

  const declare = defineDomainTool({
    name: "declare_incident",
    description: "Declare a new incident against one or more services (freezes their deploys).",
    input: z.object({
      title: z.string(),
      severity: z.enum(["sev1", "sev2", "sev3"]).optional(),
      services: z.array(z.string()).optional(),
    }),
    destructive: true,
    requires: { permission: PERMISSIONS.declare },
    handler: (input, ctx) => {
      const incident = declareIncident(store, {
        title: input.title,
        severity: input.severity ?? "sev3",
        services: input.services ?? [],
        actor: ctx.principal?.actor ?? "unknown",
      });

      return Promise.resolve({ incident });
    },
  });

  const annotate = defineDomainTool({
    name: "annotate_incident",
    description: "Append a note to an incident's timeline and optionally transition its status.",
    input: z.object({
      id: z.number(),
      note: z.string(),
      status: z.enum(["open", "mitigated", "resolved"]).optional(),
    }),
    destructive: true,
    requires: { permission: PERMISSIONS.annotate },
    handler: (input, ctx) => {
      const incident = updateIncident(store, input.id, {
        note: input.note,
        actor: ctx.principal?.actor ?? "unknown",
        ...(input.status === undefined ? {} : { status: input.status }),
      });

      return Promise.resolve(incident === undefined ? { error: "no such incident" } : { incident });
    },
  });

  const gate = defineDomainTool({
    name: "gate_deploy",
    description:
      "Request a deploy of a service; BLOCKED while that service has an active incident.",
    input: z.object({ service: z.string(), version: z.string().optional() }),
    destructive: true,
    requires: { permission: PERMISSIONS.gate },
    handler: (input) => {
      const deploy = requestDeploy(store, {
        service: input.service,
        version: input.version ?? "0.0.0",
      });

      return Promise.resolve({ deploy });
    },
  });

  const listDeploys = defineDomainTool({
    name: "list_deploys",
    description: "List every deploy request and whether it shipped or was frozen.",
    input: z.object({}),
    destructive: false,
    handler: () => Promise.resolve({ deploys: store.deploys }),
  });

  return [listServices, declare, annotate, gate, listDeploys];
}

/**
 * Build the ops console and mount the `@lesto/mcp` governance on a fresh `@lesto/web` app.
 *
 * `app` is the {@link App} the framework tools dispatch back INTO. With the generic `handle_request`
 * OMITTED (least-privilege, ADR 0043 D4) the domain tools act on `store` directly, so `app` is read
 * only by the framework read tools. The two substrates differ here, and ONLY here:
 *   - Node passes a forward-reference to the BOOTED KERNEL app — `./app.ts` creates it with
 *     `await createApp` AFTER this returns, so the reference must be late-bound.
 *   - the edge omits `app`: there is no kernel, so it falls back to THIS `api` (self-dispatch).
 */
export function buildGovernedApi(options: GovernanceOptions, app?: App): GovernedApi {
  // Forced by OpenAuth's token shape (aud = clientID, no RFC 8707) — see `clientID` above.
  const resource = options.clientID;
  const resourceMetadataUrl = `${options.baseUrl}/.well-known/oauth-protected-resource`;

  const store = seedOps();
  const audit: McpAuditRecord[] = [];

  // The console's HTTP surface — its own routes (services / incidents / deploys). `list_routes`
  // reports these; the GOVERNED MCP write path is the domain tools below, which act on the same
  // `store`. The cross-entity deploy-freeze rule lives in ../mcp/ops.ts.
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
        actor: "http@ops.example.com",
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
        actor: "http@ops.example.com",
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

      // A blocked deploy is a successful, recorded decision (201) — the freeze is the feature.
      return c.json({ deploy }, 201);
    });

  // Captured BEFORE the MCP routes are mounted, so `list_routes` reports the console only, not the
  // MCP plumbing.
  const routes = api.routes();

  // Node redirects the framework tools' dispatch through its booted kernel app; the edge (no `app`)
  // dispatches straight back into this `api`. The domain tools do not need it (they act on `store`).
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
      // The app's real actions as governed domain tools (ADR 0043); each write owns its floor.
      domainTools: opsDomainTools(store),
      // Least privilege: the surface is covered by domain tools, so drop the generic driver — an
      // agent reaches exactly the declared actions and nothing else (ADR 0043 D4).
      omitTools: ["handle_request"],
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
    // The OCP-7 role floor: each domain tool's `requires.permission` is adjudicated against this
    // policy, per action. A destructive tool's scope defaults to `mcp:write`, so the floor
    // intersects the scope ceiling exactly — an over-scoped stakeholder is still refused by ROLE.
    policy: opsPolicy,
  });

  api
    .get("/.well-known/oauth-protected-resource", handlers.metadata)
    .post("/mcp", handlers.rpc)
    .get("/mcp", handlers.noStream);

  return { api, resource, audit, store };
}

/**
 * Demo `subject → roles`: the OpenAuth subject (an email) maps to its ops role. The RS resolves the
 * role from the SUBJECT (its source of truth is the identity service, not the token), and the OCP-7
 * per-tool floor ({@link opsPolicy}) reads it — so `sre` and `oncall` now DIVERGE at runtime (both
 * write, but only `sre` may `gate_deploy`).
 */
export function demoRolesOf(actor: string): string[] {
  if (actor === "sre@ops.example.com") return [ROLES.sre];
  if (actor === "oncall@ops.example.com") return [ROLES.oncall];
  if (actor === "stakeholder@ops.example.com") return [ROLES.stakeholder];

  return [ROLES.viewer];
}
