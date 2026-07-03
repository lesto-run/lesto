/**
 * The proof: a REAL OpenAuth issuer mints tokens, and the Lesto MCP Resource Server validates them
 * purely via the issuer's JWKS — the `@lesto/mcp` governance unchanged — over a MULTI-DOMAIN ops
 * console (services + incidents + deploys) whose real actions are FIRST-CLASS governed MCP tools
 * (ADR 0043): `declare_incident` / `annotate_incident` / `gate_deploy`, each owning its own per-tool
 * policy floor, with the generic `handle_request` OMITTED for least privilege.
 *
 * Both servers run live (OpenAuth on a node:http server, the RS on `@lesto/runtime` serve); tokens
 * come from the real PKCE dance (../idp/dance.ts). It asserts, over the wire:
 *   - the RS advertises the OpenAuth issuer in its RFC 9728 metadata,
 *   - no token → 401, a token minted for ANOTHER client → 401 (confused-deputy guard),
 *   - the surface is domain tools, NOT the generic `handle_request` (least privilege),
 *   - an SRE runs a real incident-response CHAIN through the domain tools — a declared incident
 *     FREEZES a subsequent deploy, and resolving it CLEARS it (cross-domain cause-and-effect),
 *   - **the four-identity matrix** — the acceptance gate: a viewer refused by the scope CEILING, a
 *     stakeholder by the ROLE FLOOR, and — the row that was impossible under `handle_request` —
 *     `oncall` MAY declare an incident but is REFUSED a deploy gate, while `sre` may do both,
 *   - the audit names the DOMAIN action (`gate_deploy`), not one opaque `handle_request`.
 */

import { serve as honoServe } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openSqlite, serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";
import type { McpAuditRecord } from "@lesto/mcp";

import { issuerApp } from "../idp/issuer";
import { CLIENT_ID, getAccessToken } from "../idp/dance";
import { buildRs, demoRolesOf } from "../mcp/app";

const ORIGIN = "https://console.example.test";
const MCP_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

interface Harness {
  rsBase: string;
  issuerUrl: string;
  sreToken: string;
  oncallToken: string;
  viewerToken: string;
  stakeholderToken: string;
  foreignToken: string;
  audit: McpAuditRecord[];
  rsServer: Server;
  idpServer: ReturnType<typeof honoServe>;
  close: () => void;
}

let h: Harness;
let id = 0;

/** POST a JSON-RPC message to the RS `/mcp` with the bearer + Streamable-HTTP headers. */
async function rpc(body: Record<string, unknown>, token?: string): Promise<Response> {
  const headers: Record<string, string> = { ...MCP_HEADERS, origin: ORIGIN };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;

  return fetch(`${h.rsBase}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** Call a NAMED domain tool as `token`; returns the RPC status, the tool result, and any challenge. */
async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; result: unknown; wwwAuth: string | null }> {
  const res = await rpc(
    { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } },
    token,
  );
  const wwwAuth = res.headers.get("www-authenticate");

  if (res.status !== 200) return { status: res.status, result: undefined, wwwAuth };

  const payload = (await res.json()) as {
    result?: { structuredContent?: unknown; content?: { text?: string }[] };
  };
  const result =
    payload.result?.structuredContent ?? JSON.parse(payload.result?.content?.[0]?.text ?? "null");

  return { status: 200, result, wwwAuth };
}

beforeAll(async () => {
  // 1. The OpenAuth issuer on a live node:http server.
  const idpServer = await new Promise<ReturnType<typeof honoServe>>((resolve) => {
    const s = honoServe({ fetch: issuerApp.fetch, port: 0 }, () => resolve(s));
  });
  const idpPort = (idpServer.address() as { port: number }).port;
  const issuerUrl = `http://localhost:${idpPort}`;

  // 2. The Lesto RS, pointed at the issuer's JWKS (resource = the OpenAuth client id).
  const { db: handle, close } = await openSqlite();
  const { app, audit } = await buildRs({
    handle,
    issuer: issuerUrl,
    jwksUrl: new URL(`${issuerUrl}/.well-known/jwks.json`),
    clientID: CLIENT_ID,
    baseUrl: "http://rs.example.test",
    allowedOrigins: [ORIGIN],
    rolesOf: demoRolesOf,
  });
  const rsServer = await serve(app, { port: 0 });

  // 3. Real tokens from the real dance — one per identity in the acceptance matrix.
  h = {
    rsBase: `http://127.0.0.1:${rsServer.port}`,
    issuerUrl,
    sreToken: await getAccessToken(issuerUrl, "sre"),
    // Holds mcp:write and the oncall role: declares incidents, but the floor denies deploy gating.
    oncallToken: await getAccessToken(issuerUrl, "oncall"),
    viewerToken: await getAccessToken(issuerUrl, "viewer"),
    // Over-scoped: holds mcp:write, but the role floor grants it none of the action permissions.
    stakeholderToken: await getAccessToken(issuerUrl, "stakeholder"),
    // A valid token minted for a DIFFERENT client id → wrong `aud` → must be refused.
    foreignToken: await getAccessToken(issuerUrl, "sre", "some-other-client"),
    audit,
    rsServer,
    idpServer,
    close,
  };
});

afterAll(async () => {
  await h.rsServer.close();
  h.idpServer.close();
  h.close();
});

describe("Lesto MCP ops console validates a real OpenAuth issuer (over live HTTP)", () => {
  it("advertises the OpenAuth issuer in its RFC 9728 metadata", async () => {
    const res = await fetch(`${h.rsBase}/.well-known/oauth-protected-resource`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: CLIENT_ID,
      authorization_servers: [h.issuerUrl],
    });
  });

  it("refuses a request with no token (401)", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(401);
  });

  it("refuses a valid token minted for another client (confused-deputy guard, 401)", async () => {
    const res = await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      h.foreignToken,
    );

    expect(res.status).toBe(401);
  });

  it("advertises the domain tools and OMITS the generic handle_request (least privilege, D4)", async () => {
    const list = await rpc(
      { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} },
      h.sreToken,
    );
    expect(list.status).toBe(200);

    const names = (
      ((await list.json()) as { result?: { tools?: { name: string }[] } }).result?.tools ?? []
    ).map((t) => t.name);

    expect(names).toEqual(
      expect.arrayContaining(["declare_incident", "gate_deploy", "list_services"]),
    );
    expect(names).not.toContain("handle_request");
  });

  it("lets an SRE run the incident-response chain through the domain tools (incident freezes a deploy)", async () => {
    // A clean deploy ships (no incident yet).
    const clean = await callTool(h.sreToken, "gate_deploy", {
      service: "checkout",
      version: "1.0.0",
    });
    expect((clean.result as { deploy: { status: string } }).deploy.status).toBe("deployed");

    // Declare a sev1 against checkout — the WRITE that should freeze the next deploy.
    const declared = await callTool(h.sreToken, "declare_incident", {
      title: "Checkout 500s",
      severity: "sev1",
      services: ["checkout"],
    });
    const incidentId = (declared.result as { incident: { id: number } }).incident.id;

    // The SAME deploy is now blocked — cross-domain cause-and-effect through the domain tool.
    const frozen = await callTool(h.sreToken, "gate_deploy", {
      service: "checkout",
      version: "1.0.1",
    });
    expect((frozen.result as { deploy: { status: string } }).deploy.status).toBe("blocked");

    // Resolve the incident, then the deploy clears.
    const resolved = await callTool(h.sreToken, "annotate_incident", {
      id: incidentId,
      note: "recovered",
      status: "resolved",
    });
    expect((resolved.result as { incident: { status: string } }).incident.status).toBe("resolved");

    const cleared = await callTool(h.sreToken, "gate_deploy", {
      service: "checkout",
      version: "1.0.1",
    });
    expect((cleared.result as { deploy: { status: string } }).deploy.status).toBe("deployed");

    // The audit names the DOMAIN action — `gate_deploy`, not one opaque `handle_request`.
    expect(h.audit).toContainEqual(
      expect.objectContaining({ tool: "gate_deploy", outcome: "ok", actor: "sre@ops.example.com" }),
    );
  });

  it("refuses a viewer's write at the SCOPE CEILING, before the floor (403, scope=mcp:write)", async () => {
    const denied = await callTool(h.viewerToken, "declare_incident", {
      title: "nope",
      severity: "sev3",
    });

    expect(denied.status).toBe(403);
    // The ceiling names the write scope — a read-scoped token can reach no write, whatever its role.
    expect(denied.wwwAuth).toContain('error="insufficient_scope"');
    expect(denied.wwwAuth).toContain('scope="mcp:write"');
  });

  it("refuses an over-scoped stakeholder's write at the ROLE FLOOR (403, names the permission)", async () => {
    const denied = await callTool(h.stakeholderToken, "declare_incident", {
      title: "exec wants this",
      severity: "sev3",
    });

    // Clears the scope CEILING (holds mcp:write) but the FLOOR refuses: the challenge names the
    // missing PERMISSION, proving the role floor — not the ceiling — stopped a token the scope allows.
    expect(denied.status).toBe(403);
    expect(denied.wwwAuth).toContain('scope="incident:declare"');
  });

  it("THE SPLIT: oncall MAY declare an incident but is REFUSED a deploy gate (the row handle_request couldn't express)", async () => {
    // oncall holds mcp:write, so it clears the ceiling on both — the floor is what discriminates.
    const declared = await callTool(h.oncallToken, "declare_incident", {
      title: "oncall paged: search degraded",
      severity: "sev2",
      services: ["search"],
    });
    expect(declared.status).toBe(200);
    expect((declared.result as { incident: { title: string } }).incident.title).toContain(
      "search degraded",
    );

    const gate = await callTool(h.oncallToken, "gate_deploy", {
      service: "search",
      version: "2.0.0",
    });
    expect(gate.status).toBe(403);
    // The floor names the permission oncall lacks — the exact split unenforceable under handle_request.
    expect(gate.wwwAuth).toContain('scope="deploy:gate"');
  });

  it("lets an SRE gate a deploy — the full-control identity clears the floor on every action", async () => {
    const gate = await callTool(h.sreToken, "gate_deploy", {
      service: "billing",
      version: "4.2.0",
    });

    expect(gate.status).toBe(200);
    expect((gate.result as { deploy: { status: string } }).deploy.status).toBe("deployed");
  });
});
