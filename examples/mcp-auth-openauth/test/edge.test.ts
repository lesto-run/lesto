/**
 * The edge proof: the SAME governed app, run through `@lesto/cloudflare`'s `toFetchHandler` —
 * the EXACT handler `mcp/worker.ts` deploys to Cloudflare — governs a real OpenAuth issuer's
 * tokens identically to the Node server (../test/integration.test.ts). No kernel, no sqlite, no
 * workerd: this drives `buildHandler` in-process against a live local issuer, so the edge path
 * is a CI gate, not just a deploy-time hope.
 *
 * It asserts, against the fetch handler:
 *   - the RS advertises the OpenAuth issuer in its RFC 9728 metadata,
 *   - no token → 401, a token minted for ANOTHER client → 401 (confused-deputy guard),
 *   - an operator drives the scout's console, the write visible via `GET /scouting` (so the MCP
 *     tool's dispatch back INTO the edge app is exercised, not just the gate),
 *   - a viewer is refused the destructive tool — the scope ceiling from `properties.scopes`.
 *
 * Uses the in-memory `/scouting` write only (no live MLB) so it's a deterministic CI gate.
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
  operatorToken: string;
  viewerToken: string;
  foreignToken: string;
}

let h: Harness;

/** POST a JSON-RPC message to the edge handler's `/mcp`. No `Origin` (a non-browser agent). */
async function edgeRpc(body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { ...MCP_HEADERS };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;

  return h.handler(
    new Request(`${RS_BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

/** Unwrap a `tools/call` text result. */
function toolJson<T>(payload: unknown): T {
  const wrapped = payload as { result?: { content?: { text?: string }[] } };

  return JSON.parse(wrapped.result?.content?.[0]?.text ?? "null") as T;
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
    operatorToken: await getAccessToken(issuerUrl, "operator"),
    viewerToken: await getAccessToken(issuerUrl, "viewer"),
    foreignToken: await getAccessToken(issuerUrl, "operator", "some-other-client"),
  };
});

afterAll(() => {
  h.idpServer.close();
});

describe("Lesto MCP RS on the edge (toFetchHandler) validates a real OpenAuth issuer", () => {
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

  it("lets an operator drive the scout's console, visible via GET /scouting", async () => {
    const list = await edgeRpc(
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      h.operatorToken,
    );
    expect(list.status).toBe(200);
    const tools =
      ((await list.json()) as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
    expect(tools.map((t) => t.name)).toContain("handle_request");

    const res = await edgeRpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "handle_request",
          arguments: {
            method: "POST",
            path: "/scouting",
            body: { playerId: 677951, name: "Bobby Witt Jr.", note: "five-tool SS" },
          },
        },
      },
      h.operatorToken,
    );
    expect(res.status).toBe(200);
    expect(toolJson<{ status: number }>(await res.json()).status).toBe(201);

    // The MCP tool dispatched back into the edge app — confirm the write landed.
    const scouting = await h.handler(new Request(`${RS_BASE}/scouting`));
    const body = (await scouting.json()) as { board: { playerId: number; name: string }[] };
    expect(body.board).toContainEqual(
      expect.objectContaining({ playerId: 677951, name: "Bobby Witt Jr." }),
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
          arguments: { method: "POST", path: "/scouting", body: { playerId: 1, name: "nope" } },
        },
      },
      h.viewerToken,
    );

    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });
});
