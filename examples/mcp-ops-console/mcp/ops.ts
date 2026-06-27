/**
 * The ops console's domain — three linked entities an SRE agent reasons across:
 *
 *   services   the things that can break (a name, a tier, a health state)
 *   incidents  an outage against one or more services (severity, status, a timeline)
 *   deploys    a release to a service, GATED while that service has an open incident
 *
 * This is ordinary in-memory domain code behind the MCP server — deliberately NOT a live
 * external API (unlike the sibling MLB example), so the base scripted agent flow is fully
 * deterministic and needs no keys or network. The whole point of the example is that an agent
 * reaches this domain through the SAME OAuth-gated `@lesto/mcp` governance as everything else,
 * and that a real incident-response task chains across all three entities: declare an incident,
 * attach the affected services, watch a deploy get BLOCKED by that incident, post mitigation
 * notes, resolve, then watch the same deploy be ALLOWED.
 *
 * Every method is a pure function of the {@link OpsStore} it's called on, so the same store
 * backs the Node and edge substrates unchanged. The cross-entity rule (`deploy gating`) lives
 * here, in the domain — the MCP layer only governs WHO may invoke it, never reimplements it.
 */

/** A service that can experience (and recover from) an incident. */
export interface Service {
  id: string;
  name: string;
  /** `tier1` services gate deploys hard; lower tiers are advisory (a richer-policy hook). */
  tier: "tier1" | "tier2" | "tier3";
  /** Derived from open incidents: `healthy` until something opens against it. */
  health: "healthy" | "degraded" | "down";
}

/** One note on an incident's timeline (who, when, what). */
export interface TimelineEntry {
  at: string;
  actor: string;
  note: string;
}

/** An incident against one or more services. */
export interface Incident {
  id: number;
  title: string;
  severity: "sev1" | "sev2" | "sev3";
  status: "open" | "mitigated" | "resolved";
  services: string[];
  timeline: TimelineEntry[];
  openedAt: string;
  resolvedAt: string | null;
}

/** A release to a service — `blocked` while that service has an open incident. */
export interface Deploy {
  id: number;
  service: string;
  version: string;
  status: "blocked" | "deployed";
  reason: string;
  at: string;
}

/** The whole console's mutable state — closed over by the governed app, one per boot. */
export interface OpsStore {
  services: Service[];
  incidents: Incident[];
  deploys: Deploy[];
}

/** A fresh console seeded with a small fleet — three services across two tiers. */
export function seedOps(): OpsStore {
  return {
    services: [
      { id: "checkout", name: "Checkout API", tier: "tier1", health: "healthy" },
      { id: "search", name: "Search", tier: "tier2", health: "healthy" },
      { id: "billing", name: "Billing", tier: "tier1", health: "healthy" },
    ],
    incidents: [],
    deploys: [],
  };
}

/** Look a service up by id (the join key incidents + deploys reference). */
export function findService(store: OpsStore, id: string): Service | undefined {
  return store.services.find((s) => s.id === id);
}

/** True iff `service` currently has an incident that is neither resolved (open or mitigated). */
export function hasActiveIncident(store: OpsStore, service: string): boolean {
  return store.incidents.some((i) => i.status !== "resolved" && i.services.includes(service));
}

/** Recompute a service's health from the incidents currently open against it. */
function recomputeHealth(store: OpsStore, serviceId: string): void {
  const svc = findService(store, serviceId);
  if (svc === undefined) return;

  const active = store.incidents.filter(
    (i) => i.status !== "resolved" && i.services.includes(serviceId),
  );
  const worst = active.reduce<Service["health"]>((acc, i) => {
    if (i.severity === "sev1") return "down";
    if (acc === "down") return "down";

    return "degraded";
  }, "healthy");

  svc.health = active.length === 0 ? "healthy" : worst;
}

/** What {@link declareIncident} needs from the caller. */
export interface DeclareIncidentInput {
  title: string;
  severity: Incident["severity"];
  services: string[];
  actor: string;
}

/** Open a new incident, mark its services unhealthy, and start its timeline. */
export function declareIncident(store: OpsStore, input: DeclareIncidentInput): Incident {
  const known = input.services.filter((id) => findService(store, id) !== undefined);
  const at = new Date().toISOString();
  const incident: Incident = {
    id: store.incidents.length + 1,
    title: input.title,
    severity: input.severity,
    status: "open",
    services: known,
    timeline: [{ at, actor: input.actor, note: `declared ${input.severity}` }],
    openedAt: at,
    resolvedAt: null,
  };
  store.incidents.push(incident);
  for (const id of known) recomputeHealth(store, id);

  return incident;
}

/** Append a note to an incident's timeline and, when given, transition its status. */
export function updateIncident(
  store: OpsStore,
  id: number,
  input: { note: string; status?: Incident["status"]; actor: string },
): Incident | undefined {
  const incident = store.incidents.find((i) => i.id === id);
  if (incident === undefined) return undefined;

  if (input.status !== undefined) {
    incident.status = input.status;
    incident.resolvedAt = input.status === "resolved" ? new Date().toISOString() : null;
  }
  incident.timeline.push({
    at: new Date().toISOString(),
    actor: input.actor,
    note: input.note,
  });
  for (const svc of incident.services) recomputeHealth(store, svc);

  return incident;
}

/** What {@link requestDeploy} needs from the caller. */
export interface RequestDeployInput {
  service: string;
  version: string;
}

/**
 * Request a deploy of `version` to `service`. The CROSS-ENTITY RULE lives here: while the
 * service has an active incident the deploy is recorded as `blocked` (a freeze), otherwise it
 * proceeds. This is the chained-task payoff — the agent must resolve the incident before the
 * same deploy is allowed.
 */
export function requestDeploy(store: OpsStore, input: RequestDeployInput): Deploy {
  const svc = findService(store, input.service);
  const blocked = svc === undefined ? true : hasActiveIncident(store, input.service);
  const reason =
    svc === undefined
      ? `unknown service "${input.service}"`
      : blocked
        ? `frozen: ${svc.name} has an active incident`
        : "no active incident — cleared to ship";

  const deploy: Deploy = {
    id: store.deploys.length + 1,
    service: input.service,
    version: input.version,
    status: blocked ? "blocked" : "deployed",
    reason,
    at: new Date().toISOString(),
  };
  store.deploys.push(deploy);

  return deploy;
}
