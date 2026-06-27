/**
 * The proof: a REAL OpenAuth issuer mints tokens, and the Lesto MCP Resource Server validates them
 * purely via the issuer's JWKS — the `@lesto/mcp` governance unchanged — over a MULTI-DOMAIN ops
 * console (services + incidents + deploys).
 *
 * Both servers run live (OpenAuth on a node:http server, the RS on `@lesto/runtime` serve); tokens
 * come from the real PKCE dance (../idp/dance.ts). It asserts, over the wire:
 *   - the RS advertises the OpenAuth issuer in its RFC 9728 metadata,
 *   - no token → 401,
 *   - a token minted for ANOTHER OpenAuth client → 401 (confused-deputy guard),
 *   - an SRE (mcp:read mcp:write) runs a real incident-response CHAIN through the MCP tools — a
 *     declared incident FREEZES a subsequent deploy, and resolving the incident CLEARS it (the
 *     cross-domain cause-and-effect, observed via the tool's own dispatched writes),
 *   - a viewer (mcp:read) is refused the destructive tool — the scope ceiling, sourced from the
 *     OpenAuth token's `properties.scopes`.
 *
 * The governance assertions use only the in-memory ops console (no external API), so CI is
 * deterministic; the agent narration is exercised by `agent.ts`.
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
  sreToken: string;
  viewerToken: string;
  stakeholderToken: string;
  foreignToken: string;
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

/** Drive the `handle_request` tool as `token` and return the app's parsed `{ status, data }`. */
async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ rpcStatus: number; appStatus: number; data: unknown }> {
  const args: Record<string, unknown> = { method, path };
  if (body !== undefined) args.body = body;

  const res = await rpc(
    { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "handle_request", arguments: args } },
    token,
  );
  if (res.status !== 200) return { rpcStatus: res.status, appStatus: 0, data: undefined };

  const payload = (await res.json()) as { result?: { content?: { text?: string }[] } };
  const wrapped = JSON.parse(payload.result?.content?.[0]?.text ?? "null") as {
    status: number;
    body: string;
  };

  return { rpcStatus: 200, appStatus: wrapped.status, data: JSON.parse(wrapped.body || "null") };
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
  const { app } = await buildRs({
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
    sreToken: await getAccessToken(issuerUrl, "sre"),
    viewerToken: await getAccessToken(issuerUrl, "viewer"),
    // Over-scoped: holds mcp:write, but the role floor doesn't grant it `console:operate`.
    stakeholderToken: await getAccessToken(issuerUrl, "stakeholder"),
    // A valid token minted for a DIFFERENT client id → wrong `aud` → must be refused.
    foreignToken: await getAccessToken(issuerUrl, "sre", "some-other-client"),
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
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, h.foreignToken);

    expect(res.status).toBe(401);
  });

  it("lets an SRE run the incident-response chain (incident freezes a deploy, resolve clears it)", async () => {
    // The console's tools are listed for a write-scoped principal.
    const list = await rpc({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }, h.sreToken);
    expect(list.status).toBe(200);
    const tools =
      ((await list.json()) as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
    expect(tools.map((t) => t.name)).toContain("handle_request");

    // A clean deploy ships (no incident yet).
    const clean = await call(h.sreToken, "POST", "/deploys", { service: "checkout", version: "1.0.0" });
    expect(clean.appStatus).toBe(201);
    expect((clean.data as { deploy: { status: string } }).deploy.status).toBe("deployed");

    // Declare a sev1 against checkout — the WRITE that should freeze the next deploy.
    const declared = await call(h.sreToken, "POST", "/incidents", {
      title: "Checkout 500s",
      severity: "sev1",
      services: ["checkout"],
    });
    expect(declared.appStatus).toBe(201);
    const incidentId = (declared.data as { incident: { id: number } }).incident.id;

    // The SAME deploy is now blocked — cross-domain cause-and-effect through the tool's dispatch.
    const frozen = await call(h.sreToken, "POST", "/deploys", { service: "checkout", version: "1.0.1" });
    expect((frozen.data as { deploy: { status: string } }).deploy.status).toBe("blocked");

    // Resolve the incident, then the deploy clears.
    const resolved = await call(h.sreToken, "POST", `/incidents/${incidentId}/notes`, {
      note: "recovered",
      status: "resolved",
    });
    expect((resolved.data as { incident: { status: string } }).incident.status).toBe("resolved");

    const cleared = await call(h.sreToken, "POST", "/deploys", { service: "checkout", version: "1.0.1" });
    expect((cleared.data as { deploy: { status: string } }).deploy.status).toBe("deployed");
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
            path: "/incidents",
            body: { title: "nope", severity: "sev3", services: [] },
          },
        },
      },
      h.viewerToken,
    );

    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });

  it("refuses an over-scoped stakeholder's write — the ROLE FLOOR, not the scope ceiling (OCP-7, 403)", async () => {
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "handle_request",
          arguments: {
            method: "POST",
            path: "/incidents",
            body: { title: "exec wants this shipped", severity: "sev3", services: [] },
          },
        },
      },
      h.stakeholderToken,
    );

    // The stakeholder clears the scope CEILING (it holds `mcp:write`) but the per-tool POLICY FLOOR
    // refuses it: the challenge names the missing PERMISSION (`console:operate`), not the write
    // scope — proving the role floor, not the ceiling, stopped a token the scope alone would allow.
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('scope="console:operate"');
  });
});
