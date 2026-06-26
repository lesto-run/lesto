/**
 * The proof: a REAL OpenAuth issuer mints tokens, and the Lesto MCP Resource Server validates
 * them purely via the issuer's JWKS — the `@lesto/mcp` governance unchanged.
 *
 * Both servers run live (OpenAuth on a node:http server, the RS on `@lesto/runtime` serve);
 * tokens come from the real PKCE dance (../idp/dance.ts). It asserts, over the wire:
 *   - the RS advertises the OpenAuth issuer in its RFC 9728 metadata,
 *   - no token → 401,
 *   - a token minted for ANOTHER OpenAuth client → 401 (confused-deputy guard),
 *   - an operator (mcp:read mcp:write) drives the scout's console (a `POST /scouting` write),
 *   - a viewer (mcp:read) is refused the destructive tool — the scope ceiling, sourced from
 *     the OpenAuth token's `properties.scopes`.
 *
 * The governance assertions use the in-memory `/scouting` write only (no live MLB) so CI is
 * deterministic; the live MLB reads are exercised by `agent.ts`.
 */

import { serve as honoServe } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openSqlite, serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";

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
  operatorToken: string;
  viewerToken: string;
  foreignToken: string;
  rsServer: Server;
  idpServer: ReturnType<typeof honoServe>;
  close: () => void;
  board: { playerId: number; name: string }[];
}

let h: Harness;

/** POST a JSON-RPC message to the RS `/mcp` with the bearer + Streamable-HTTP headers. */
async function rpc(body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { ...MCP_HEADERS, origin: ORIGIN };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;

  return fetch(`${h.rsBase}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** Unwrap a `tools/call` text result. */
function toolJson<T>(payload: unknown): T {
  const wrapped = payload as { result?: { content?: { text?: string }[] } };

  return JSON.parse(wrapped.result?.content?.[0]?.text ?? "null") as T;
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
  const { app, board } = await buildRs({
    handle,
    issuer: issuerUrl,
    jwksUrl: new URL(`${issuerUrl}/.well-known/jwks.json`),
    clientID: CLIENT_ID,
    baseUrl: "http://rs.example.test",
    allowedOrigins: [ORIGIN],
    rolesOf: demoRolesOf,
  });
  const rsServer = await serve(app, { port: 0 });

  // 3. Real tokens from the real dance.
  h = {
    rsBase: `http://127.0.0.1:${rsServer.port}`,
    issuerUrl,
    operatorToken: await getAccessToken(issuerUrl, "operator"),
    viewerToken: await getAccessToken(issuerUrl, "viewer"),
    // A valid token minted for a DIFFERENT client id → wrong `aud` → must be refused.
    foreignToken: await getAccessToken(issuerUrl, "operator", "some-other-client"),
    rsServer,
    idpServer,
    close,
    board: board as { playerId: number; name: string }[],
  };
});

afterAll(async () => {
  await h.rsServer.close();
  h.idpServer.close();
  h.close();
});

describe("Lesto MCP RS validates a real OpenAuth issuer (over live HTTP)", () => {
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

  it("lets an operator drive the scout's console through the MCP tools", async () => {
    const list = await rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      h.operatorToken,
    );
    expect(list.status).toBe(200);
    const tools =
      ((await list.json()) as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
    expect(tools.map((t) => t.name)).toContain("handle_request");

    const res = await rpc(
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
    const appResponse = toolJson<{ status: number; body: string }>(await res.json());
    expect(appResponse.status).toBe(201);
    expect(h.board).toContainEqual(
      expect.objectContaining({ playerId: 677951, name: "Bobby Witt Jr." }),
    );
  });

  it("refuses a viewer's destructive call — the scope ceiling from properties.scopes (403)", async () => {
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "handle_request",
          arguments: {
            method: "POST",
            path: "/scouting",
            body: { playerId: 1, name: "nope", note: "" },
          },
        },
      },
      h.viewerToken,
    );

    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });
});
