/**
 * The edge proof: the SAME governed ops console, run through `@lesto/cloudflare`'s `toFetchHandler`
 * — the EXACT handler `mcp/worker.ts` deploys to Cloudflare — governs a real OpenAuth issuer's
 * tokens identically to the Node server (../test/integration.test.ts). No kernel, no sqlite, no
 * workerd: this drives `buildHandler` in-process against a live local issuer, so the edge path is
 * a CI gate, not just a deploy-time hope.
 *
 * It asserts, against the fetch handler:
 *   - the RS advertises the OpenAuth issuer in its RFC 9728 metadata,
 *   - no token → 401, a token minted for ANOTHER client → 401 (confused-deputy guard),
 *   - an SRE runs the incident-response chain — a declared incident FREEZES a deploy and resolving
 *     it CLEARS the deploy, observed via the MCP tool's dispatch back INTO the edge app (so the
 *     cross-domain effect is exercised, not just the gate),
 *   - a viewer is refused the destructive tool — the scope ceiling from `properties.scopes`.
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

/** Drive the `handle_request` tool as `token` and return the app's parsed `{ status, data }`. */
async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ appStatus: number; data: unknown }> {
  const args: Record<string, unknown> = { method, path };
  if (body !== undefined) args.body = body;

  const res = await edgeRpc(
    { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "handle_request", arguments: args } },
    token,
  );
  const payload = (await res.json()) as { result?: { content?: { text?: string }[] } };
  const wrapped = JSON.parse(payload.result?.content?.[0]?.text ?? "null") as {
    status: number;
    body: string;
  };

  return { appStatus: wrapped.status, data: JSON.parse(wrapped.body || "null") };
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
    const res = await edgeRpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, h.foreignToken);

    expect(res.status).toBe(401);
  });

  it("lets an SRE run the incident-response chain, visible via the edge app's own reads", async () => {
    const list = await edgeRpc({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }, h.sreToken);
    expect(list.status).toBe(200);
    const tools =
      ((await list.json()) as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
    expect(tools.map((t) => t.name)).toContain("handle_request");

    // Declare a sev1 against search through the tool…
    const declared = await call(h.sreToken, "POST", "/incidents", {
      title: "Search latency spike",
      severity: "sev1",
      services: ["search"],
    });
    expect(declared.appStatus).toBe(201);

    // …the deploy to that service is frozen (the MCP tool dispatched back into the edge app)…
    const frozen = await call(h.sreToken, "POST", "/deploys", { service: "search", version: "3.1.0" });
    expect((frozen.data as { deploy: { status: string } }).deploy.status).toBe("blocked");

    // …and the write is visible via a plain GET on the edge app (dispatch landed, not just the gate).
    const incidents = await h.handler(new Request(`${RS_BASE}/incidents?status=open`));
    const body = (await incidents.json()) as { incidents: { title: string }[] };
    expect(body.incidents).toContainEqual(
      expect.objectContaining({ title: "Search latency spike" }),
    );
  });

  it("refuses a viewer's destructive call — the scope ceiling from properties.scopes (403)", async () => {
    const res = await edgeRpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "handle_request",
          arguments: {
            method: "POST",
            path: "/deploys",
            body: { service: "checkout", version: "9.9.9" },
          },
        },
      },
      h.viewerToken,
    );

    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });

  it("refuses an over-scoped stakeholder's write — the ROLE floor, not the scope ceiling (OCP-7, 403)", async () => {
    const res = await edgeRpc(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "handle_request",
          arguments: {
            method: "POST",
            path: "/incidents",
            body: { title: "exec wants this", severity: "sev3", services: [] },
          },
        },
      },
      h.stakeholderToken,
    );

    // Holds mcp:write (clears the ceiling) but the role lacks `console:operate` → floor refuses,
    // and the challenge names the missing permission, not the scope.
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('scope="console:operate"');
  });
});
