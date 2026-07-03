/**
 * ADR 0043 — app-defined domain MCP tools: the declaration surface, its fail-closed registration
 * invariants (D2), and the dispatch-level policy floor (D3) that finally gives stdio a floor.
 *
 * These exercise the pure `@lesto/mcp` logic directly (no transport): `buildTools` adapts + gates
 * the declarations, and `dispatch` enforces the floor against a resolved principal. The four-identity
 * acceptance matrix over the LIVE HTTP transport lives in the ops-console example
 * (`examples/mcp-ops-console/test`) — here we prove the primitives it rides on.
 */

import { describe, expect, it } from "vitest";

import { z } from "zod";

import { definePolicy } from "@lesto/authz";
import type { Principal } from "@lesto/authz";
import type { App } from "@lesto/kernel";

import { buildTools, defineDomainTool, dispatch } from "../src/tools";
import type {
  LestoDomainTool,
  LestoMcpContext,
  LestoTool,
  McpAuditRecord,
  McpDevStateReader,
} from "../src/tools";

// A stub app the domain tools never drive (they act on their own closures) — present because
// `LestoMcpContext.app` is required.
const app: App = {
  handle: () => Promise.resolve({ status: 200, headers: {}, body: "" }),
  migrationsApplied: [],
};

/** The ops policy the acceptance matrix rides: sre/oncall may declare, only sre may gate a deploy. */
const policy = definePolicy({
  roles: ["sre", "oncall", "viewer"],
  can: {
    "incident:declare": ["sre", "oncall"],
    "deploy:gate": ["sre"],
  },
});

function principalOf(...roles: string[]): Principal {
  return { actor: `${roles[0] ?? "anon"}@ops.example.com`, actorRoles: roles };
}

/** A fresh context + a capturing audit array; `mode`/`policy`/`resolvePrincipal` set per test. */
function ctx(overrides: Partial<LestoMcpContext> = {}): {
  context: LestoMcpContext;
  audit: McpAuditRecord[];
} {
  const audit: McpAuditRecord[] = [];

  const context: LestoMcpContext = {
    app,
    routes: [],
    audit: (record) => void audit.push(record),
    ...overrides,
  };

  return { context, audit };
}

/** A governed, destructive domain tool — the shape the ops-console's `declare_incident` takes. */
const declareIncident = defineDomainTool({
  name: "declare_incident",
  description: "Declare a new incident.",
  input: z.object({ title: z.string() }),
  destructive: true,
  requires: { permission: "incident:declare" },
  handler: (input, c) => Promise.resolve({ title: input.title, by: c.principal?.actor }),
});

/** The tool only `sre` may reach — the split that is unenforceable under the generic handle_request. */
const gateDeploy = defineDomainTool({
  name: "gate_deploy",
  description: "Request a deploy (gated by active incidents).",
  input: z.object({ service: z.string() }),
  destructive: true,
  requires: { permission: "deploy:gate" },
  handler: (input, c) => Promise.resolve({ service: input.service, by: c.principal?.actor }),
});

const FRAMEWORK_NAME_COUNT = 10;

describe("buildTools — domain tool registration (ADR 0043 D1/D2/D4)", () => {
  it("leaves the framework set unchanged when no domain tools are declared", () => {
    const names = buildTools(ctx().context).map((tool) => tool.name);

    expect(names).toHaveLength(FRAMEWORK_NAME_COUNT);
    expect(names).not.toContain("declare_incident");
  });

  it("appends a governed domain tool AFTER the framework set, with a derived JSON Schema", () => {
    const { context } = ctx({
      policy,
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [declareIncident],
    });

    const tools = buildTools(context);
    const domain = tools.at(-1) as LestoTool;

    expect(domain.name).toBe("declare_incident");
    expect(domain.destructive).toBe(true);
    expect(domain.requiresPermission).toBe("incident:declare");
    // Derived from the Zod schema, with the `$schema` key stripped (not carried on MCP inputSchema).
    expect(domain.inputSchema).toMatchObject({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });
    expect(domain.inputSchema).not.toHaveProperty("$schema");
  });

  it("orders framework, then domain, then the dev tools", () => {
    const devState: McpDevStateReader = {
      getDiagnostics: () => null,
      recentRequests: () => [],
      recentLogs: () => [],
    };
    const { context } = ctx({
      policy,
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [declareIncident],
      devState,
    });

    const names = buildTools(context).map((tool) => tool.name);
    const domainAt = names.indexOf("declare_incident");
    const devAt = names.indexOf("tail_logs");

    expect(domainAt).toBe(FRAMEWORK_NAME_COUNT);
    expect(devAt).toBeGreaterThan(domainAt);
  });

  it("drops an omitted framework tool but keeps the domain tools (D4)", () => {
    const { context } = ctx({
      policy,
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [declareIncident],
      omitTools: ["handle_request"],
    });

    const names = buildTools(context).map((tool) => tool.name);

    expect(names).not.toContain("handle_request");
    expect(names).toContain("declare_incident");
  });

  it("refuses an omitTools entry that names no known tool (L-0c458a04, fail-closed)", () => {
    const { context } = ctx({
      policy,
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [declareIncident],
      // A typo: the intended `handle_request` would silently stay exposed without this refusal.
      omitTools: ["handle_reqeust"],
    });

    expect(() => buildTools(context)).toThrow(
      expect.objectContaining({ code: "MCP_UNKNOWN_OMIT_TOOL" }),
    );
  });

  it("omits a framework tool with no domain tools declared (back-compat omit)", () => {
    const { context } = ctx({ omitTools: ["handle_request"] });

    const names = buildTools(context).map((tool) => tool.name);

    expect(names).not.toContain("handle_request");
    expect(names).toContain("list_routes");
  });

  it("allows omitting a dev tool name on a non-dev server, and a declared domain tool name", () => {
    const { context } = ctx({
      policy,
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [declareIncident],
      // `tail_logs` is a reserved dev name (not built here); `declare_incident` is a declared domain tool.
      omitTools: ["tail_logs", "declare_incident"],
    });

    const names = buildTools(context).map((tool) => tool.name);

    expect(names).not.toContain("declare_incident");
  });

  it("refuses a domain tool whose name collides with a framework tool (D2.3)", () => {
    const { context } = ctx({
      policy,
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [{ ...declareIncident, name: "list_routes" }],
    });

    expect(() => buildTools(context)).toThrow(
      expect.objectContaining({ code: "MCP_DOMAIN_TOOL_NAME_CONFLICT" }),
    );
  });

  it("reserves the dev tool names even on a non-dev server (D2.3)", () => {
    const { context } = ctx({
      policy,
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [{ ...declareIncident, name: "tail_logs" }],
    });

    expect(() => buildTools(context)).toThrow(
      expect.objectContaining({ code: "MCP_DOMAIN_TOOL_NAME_CONFLICT" }),
    );
  });

  it("refuses two domain tools sharing a name (D2.3)", () => {
    const { context } = ctx({
      policy,
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [declareIncident, { ...gateDeploy, name: "declare_incident" }],
    });

    expect(() => buildTools(context)).toThrow(
      expect.objectContaining({ code: "MCP_DOMAIN_TOOL_NAME_CONFLICT" }),
    );
  });

  it("refuses a destructive domain tool that declares no floor and no opt-out (D2.1)", () => {
    const ungoverned: LestoDomainTool<{ title: string }> = {
      name: "wipe_everything",
      description: "Dangerous.",
      input: z.object({ title: z.string() }),
      destructive: true,
      handler: () => Promise.resolve(null),
    };
    const { context } = ctx({
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [ungoverned],
    });

    expect(() => buildTools(context)).toThrow(
      expect.objectContaining({ code: "MCP_DOMAIN_TOOL_UNGOVERNED" }),
    );
  });

  it("allows a destructive tool to ship floorless only via the loud ungoverned opt-out (D2.1)", () => {
    const escape: LestoDomainTool<{ title: string }> = {
      name: "run_diagnostic",
      description: "An explicitly ungoverned destructive action.",
      input: z.object({ title: z.string() }),
      destructive: true,
      ungoverned: true,
      handler: () => Promise.resolve({ ran: true }),
    };
    const { context } = ctx({ resolvePrincipal: () => principalOf("sre"), domainTools: [escape] });

    const tool = buildTools(context).find((t) => t.name === "run_diagnostic");

    expect(tool?.requiresPermission).toBeUndefined();
    expect(tool?.destructive).toBe(true);
  });

  it("refuses a governed domain tool when the context has no policy (D2.4)", () => {
    const { context } = ctx({
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [declareIncident],
    });

    expect(() => buildTools(context)).toThrow(
      expect.objectContaining({ code: "MCP_DOMAIN_TOOL_POLICY_REQUIRED" }),
    );
  });

  it("refuses a non-destructive governed tool with no explicit scope (L-0c458a04)", () => {
    const read: LestoDomainTool<Record<string, never>> = {
      name: "read_incident_stats",
      description: "A governed read.",
      input: z.object({}),
      destructive: false,
      requires: { permission: "incident:declare" },
      handler: () => Promise.resolve({ count: 0 }),
    };
    const { context } = ctx({
      policy,
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [read],
    });

    expect(() => buildTools(context)).toThrow(
      expect.objectContaining({ code: "MCP_DOMAIN_TOOL_SCOPE_REQUIRED" }),
    );
  });

  it("is ABSENT from a destructive domain tool with no principal resolver (D2.2)", () => {
    const { context } = ctx({ policy, domainTools: [declareIncident] });

    const names = buildTools(context).map((tool) => tool.name);

    expect(names).not.toContain("declare_incident");
  });

  it("keeps a NON-destructive governed tool without a resolver (it fails closed at the floor)", () => {
    const read: LestoDomainTool<Record<string, never>> = {
      name: "read_incident_stats",
      description: "A governed read.",
      input: z.object({}),
      destructive: false,
      requires: { scope: "mcp:read", permission: "incident:declare" },
      handler: () => Promise.resolve({ count: 0 }),
    };
    const { context } = ctx({ policy, domainTools: [read] });

    const names = buildTools(context).map((tool) => tool.name);

    expect(names).toContain("read_incident_stats");
  });
});

describe("dispatch — the domain-tool policy floor (ADR 0043 D3)", () => {
  it("runs the handler with the parsed input and resolved principal when the role is granted", async () => {
    const { context, audit } = ctx({
      mode: "operator",
      policy,
      resolvePrincipal: () => principalOf("oncall"),
      domainTools: [declareIncident],
    });
    const tools = buildTools(context);

    const result = await dispatch(context, tools, "declare_incident", { title: "Checkout 500s" });

    expect(result).toEqual({ title: "Checkout 500s", by: "oncall@ops.example.com" });
    expect(audit.at(-1)).toMatchObject({
      tool: "declare_incident",
      outcome: "ok",
      actor: "oncall@ops.example.com",
    });
  });

  it("refuses (MCP_FORBIDDEN) a subject whose roles lack the permission — the oncall≠sre split", async () => {
    const { context, audit } = ctx({
      mode: "operator",
      policy,
      resolvePrincipal: () => principalOf("oncall"),
      domainTools: [gateDeploy],
    });
    const tools = buildTools(context);

    // oncall may declare_incident but NOT gate_deploy — the exact split unenforceable under
    // the generic handle_request.
    await expect(
      dispatch(context, tools, "gate_deploy", { service: "checkout" }),
    ).rejects.toMatchObject({
      code: "MCP_FORBIDDEN",
      details: { permission: "deploy:gate" },
    });
    expect(audit.at(-1)).toMatchObject({ tool: "gate_deploy", outcome: "error" });
  });

  it("denies by default when the dispatch is unauthenticated (no resolver → empty roles)", async () => {
    // A NON-destructive governed tool survives without a resolver (D2.2 gates destructive ones), so
    // it reaches the floor with an undefined principal — which denies.
    const read: LestoDomainTool<Record<string, never>> = {
      name: "read_incident_stats",
      description: "A governed read.",
      input: z.object({}),
      destructive: false,
      requires: { scope: "mcp:read", permission: "incident:declare" },
      handler: () => Promise.resolve({ count: 1 }),
    };
    const { context } = ctx({ policy, domainTools: [read] });
    const tools = buildTools(context);

    await expect(dispatch(context, tools, "read_incident_stats", {})).rejects.toMatchObject({
      code: "MCP_FORBIDDEN",
    });
  });

  it("fails closed when a tool carries a floor but the context has no policy (backstop)", async () => {
    // buildTools would refuse to register such a tool (D2.4); dispatch is exercised directly to
    // prove the belt-and-suspenders floor still denies if one ever reaches it policy-less.
    const governed: LestoTool = {
      name: "declare_incident",
      description: "Declare an incident.",
      inputSchema: { type: "object" },
      destructive: true,
      requiresPermission: "incident:declare",
      handler: () => Promise.resolve({ ok: true }),
    };
    const { context } = ctx({ mode: "operator", resolvePrincipal: () => principalOf("sre") });

    await expect(dispatch(context, [governed], "declare_incident", {})).rejects.toMatchObject({
      code: "MCP_FORBIDDEN",
    });
  });

  it("refuses a destructive domain tool in read-only mode (operator ceiling)", async () => {
    const { context } = ctx({
      policy,
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [declareIncident],
    });
    const tools = buildTools(context);

    await expect(
      dispatch(context, tools, "declare_incident", { title: "x" }),
    ).rejects.toMatchObject({
      code: "MCP_OPERATOR_REQUIRED",
    });
  });

  it("refuses (MCP_INVALID_TOOL_INPUT) an input that fails the Zod schema at the boundary", async () => {
    const { context, audit } = ctx({
      mode: "operator",
      policy,
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [declareIncident],
    });
    const tools = buildTools(context);

    await expect(dispatch(context, tools, "declare_incident", { title: 42 })).rejects.toMatchObject(
      {
        code: "MCP_INVALID_TOOL_INPUT",
        details: { tool: "declare_incident" },
      },
    );
    expect(audit.at(-1)).toMatchObject({ tool: "declare_incident", outcome: "error" });
  });

  it("runs a NON-destructive governed tool without an operator ceiling once the floor passes", async () => {
    const read: LestoDomainTool<Record<string, never>> = {
      name: "read_incident_stats",
      description: "A governed read.",
      input: z.object({}),
      destructive: false,
      requires: { scope: "mcp:read", permission: "incident:declare" },
      handler: (_input, c) => Promise.resolve({ by: c.principal?.actor }),
    };
    // read-only mode: a non-destructive tool needs no operator ceiling, so with a granting role it runs.
    const { context } = ctx({
      policy,
      resolvePrincipal: () => principalOf("sre"),
      domainTools: [read],
    });
    const tools = buildTools(context);

    await expect(dispatch(context, tools, "read_incident_stats", {})).resolves.toEqual({
      by: "sre@ops.example.com",
    });
  });

  it("does not gate an ungoverned domain tool at the floor", async () => {
    const escape: LestoDomainTool<Record<string, never>> = {
      name: "run_diagnostic",
      description: "An explicitly ungoverned destructive action.",
      input: z.object({}),
      destructive: true,
      ungoverned: true,
      handler: () => Promise.resolve({ ran: true }),
    };
    const { context } = ctx({
      mode: "operator",
      resolvePrincipal: () => principalOf("viewer"),
      domainTools: [escape],
    });
    const tools = buildTools(context);

    // No requires → no dispatch floor; the operator ceiling is the only gate, and it passes.
    await expect(dispatch(context, tools, "run_diagnostic", {})).resolves.toEqual({ ran: true });
  });
});
