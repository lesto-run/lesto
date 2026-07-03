/**
 * The edge proof: the SAME governed ops console, run through `@lesto/cloudflare`'s `toFetchHandler`
 * — the EXACT handler `mcp/worker.ts` deploys to Cloudflare — governs a real OpenAuth issuer's
 * tokens identically to the Node server (../test/integration.test.ts). No kernel, no sqlite, no
 * workerd: this drives `buildHandler` in-process against a live local issuer, so the edge path is
 * a CI gate, not just a deploy-time hope. Since `buildGovernedApi` is byte-identical across Node and
 * the edge, the ADR 0043 domain-tool floor — including the `oncall`-can-declare-but-not-gate-deploy
 * row — must hold here too.
 *
 * It asserts, against the fetch handler:
 *   - the RS advertises the OpenAuth issuer in its RFC 9728 metadata,
 *   - no token → 401, a token minted for ANOTHER client → 401 (confused-deputy guard),
 *   - the surface is domain tools, not the generic `handle_request` (least privilege),
 *   - an SRE declares an incident through the domain tool, FREEZING a deploy — the effect visible via
 *     a plain GET on the edge app (the tool and the read share one store),
 *   - **the four-identity matrix**: a viewer refused by the scope CEILING, a stakeholder by the ROLE
 *     FLOOR, `oncall` allowed to declare but REFUSED a deploy gate, `sre` allowed both.
 */

import { serve as honoServe } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { issuerApp } from "../idp/issuer";
import { CLIENT_ID, getAccessToken } from "../idp/dance";
import { buildHandler } from "../mcp/worker";

const RS_BASE = "https://rs.example.test";
const MCP_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

interface Harness {
  issuerUrl: string;
  handler: (request: Request, ctx?: undefined) => Promise<Response>;
  idpServer: ReturnType<typeof honoServe>;
  sreToken: string;
  oncallToken: string;
  viewerToken: string;
  stakeholderToken: string;
  foreignToken: string;
}

let h: Harness;
let id = 0;

/** POST a JSON-RPC message to the edge handler's `/mcp`. No `Origin` (a non-browser agent). */
async function edgeRpc(body: Record<string, unknown>, token?: string): Promise<Response> {
  const headers: Record<string, string> = { ...MCP_HEADERS };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;

  return h.handler(
    new Request(`${RS_BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

/** Call a NAMED domain tool as `token`; returns the RPC status, the tool result, and any challenge. */
async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; result: unknown; wwwAuth: string | null }> {
  const res = await edgeRpc(
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
  // The OpenAuth issuer on a live node:http server (the RS verifies its JWKS over HTTP).
  const idpServer = await new Promise<ReturnType<typeof honoServe>>((resolve) => {
    const s = honoServe({ fetch: issuerApp.fetch, port: 0 }, () => resolve(s));
  });
  const idpPort = (idpServer.address() as { port: number }).port;
  const issuerUrl = `http://localhost:${idpPort}`;

  h = {
    issuerUrl,
    // The real Worker entry, built exactly as `worker.ts`'s `fetch` builds it.
    handler: buildHandler({ OPENAUTH_ISSUER: issuerUrl, MCP_CLIENT_ID: CLIENT_ID }, RS_BASE),
    idpServer,
    sreToken: await getAccessToken(issuerUrl, "sre"),
    oncallToken: await getAccessToken(issuerUrl, "oncall"),
    viewerToken: await getAccessToken(issuerUrl, "viewer"),
    stakeholderToken: await getAccessToken(issuerUrl, "stakeholder"),
    foreignToken: await getAccessToken(issuerUrl, "sre", "some-other-client"),
  };
});

afterAll(() => {
  h.idpServer.close();
});

describe("Lesto MCP ops console on the edge (toFetchHandler) validates a real OpenAuth issuer", () => {
  it("advertises the OpenAuth issuer in its RFC 9728 metadata", async () => {
    const res = await h.handler(new Request(`${RS_BASE}/.well-known/oauth-protected-resource`));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: CLIENT_ID,
      authorization_servers: [h.issuerUrl],
    });
  });

  it("refuses a request with no token (401)", async () => {
    const res = await edgeRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(401);
  });

  it("refuses a valid token minted for another client (confused-deputy guard, 401)", async () => {
    const res = await edgeRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      h.foreignToken,
    );

    expect(res.status).toBe(401);
  });

  it("advertises the domain tools and OMITS the generic handle_request (least privilege, D4)", async () => {
    const list = await edgeRpc(
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

  it("lets an SRE declare an incident that freezes a deploy — visible via the edge app's own read", async () => {
    // Declare a sev1 against search through the domain tool…
    const declared = await callTool(h.sreToken, "declare_incident", {
      title: "Search latency spike",
      severity: "sev1",
      services: ["search"],
    });
    expect(declared.status).toBe(200);

    // …the deploy to that service is frozen (same store the tool wrote)…
    const frozen = await callTool(h.sreToken, "gate_deploy", {
      service: "search",
      version: "3.1.0",
    });
    expect((frozen.result as { deploy: { status: string } }).deploy.status).toBe("blocked");

    // …and the write is visible via a plain GET on the edge app (the tool and the read share a store).
    const incidents = await h.handler(new Request(`${RS_BASE}/incidents?status=open`));
    const body = (await incidents.json()) as { incidents: { title: string }[] };
    expect(body.incidents).toContainEqual(
      expect.objectContaining({ title: "Search latency spike" }),
    );
  });

  it("refuses a viewer's write at the SCOPE CEILING (403, scope=mcp:write)", async () => {
    const denied = await callTool(h.viewerToken, "gate_deploy", {
      service: "checkout",
      version: "9.9.9",
    });

    expect(denied.status).toBe(403);
    expect(denied.wwwAuth).toContain('error="insufficient_scope"');
    expect(denied.wwwAuth).toContain('scope="mcp:write"');
  });

  it("refuses an over-scoped stakeholder's write at the ROLE FLOOR (403, names the permission)", async () => {
    const denied = await callTool(h.stakeholderToken, "declare_incident", {
      title: "exec wants this",
      severity: "sev3",
    });

    expect(denied.status).toBe(403);
    expect(denied.wwwAuth).toContain('scope="incident:declare"');
  });

  it("THE SPLIT: oncall MAY declare an incident but is REFUSED a deploy gate", async () => {
    const declared = await callTool(h.oncallToken, "declare_incident", {
      title: "oncall paged: billing errors",
      severity: "sev2",
      services: ["billing"],
    });
    expect(declared.status).toBe(200);

    const gate = await callTool(h.oncallToken, "gate_deploy", {
      service: "billing",
      version: "2.0.0",
    });
    expect(gate.status).toBe(403);
    expect(gate.wwwAuth).toContain('scope="deploy:gate"');
  });

  it("lets an SRE gate a deploy — the full-control identity clears the floor on every action", async () => {
    const gate = await callTool(h.sreToken, "gate_deploy", {
      service: "checkout",
      version: "5.0.0",
    });

    expect(gate.status).toBe(200);
    expect((gate.result as { deploy: { status: string } }).deploy.status).toBe("deployed");
  });
});
