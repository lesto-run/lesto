/**
 * The example's QA gate — and MA-6's headline proof: drive the authenticated remote MCP
 * server over a LIVE node:http server with real `fetch` calls carrying real signed JWTs.
 *
 * The `@lesto/mcp` package tests the RS governance and the transport in-process (it could
 * not start a server in the sandbox). This closes that gap: it boots the app behind
 * `@lesto/runtime`'s `serve`, mints tokens from the demo IdP, and exercises the whole
 * governed flow over real sockets — proving the live MCP-over-HTTP path end to end.
 *
 * What it asserts, all over the wire:
 *   - RFC 9728 discovery serves the right resource + issuer.
 *   - No token -> 401 + `WWW-Authenticate` pointing at the metadata.
 *   - A valid signature minted for ANOTHER audience -> 401 (the confused-deputy guard).
 *   - A cross-site `Origin` -> 403 before the token is read.
 *   - A `mcp:read` viewer can `tools/list` + `list_routes`, but the destructive
 *     `handle_request` is refused (403 `insufficient_scope`) — the scope ceiling.
 *   - An `mcp:read mcp:write` operator drives a real `POST /deployments`, and the deploy is
 *     then visible over plain HTTP.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openSqlite, serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";

import { buildApp, demoRolesOf } from "../src/app";
import { createDemoIdp } from "../src/idp";

// The resource id is a LOGICAL identifier (often behind a proxy), decoupled from the
// ephemeral socket the test binds — tokens are audienced to this, requests hit `base`.
const BASE_URL = "http://mcp.example.test";
const ISSUER = "https://idp.example.test/";
const ORIGIN = "https://console.example.test";

interface Harness {
  base: string;
  resource: string;
  viewerToken: string;
  operatorToken: string;
  wrongAudienceToken: string;
  server: Server;
  close: () => void;
  deployments: { app: string; ref: string }[];
}

let h: Harness;

/** POST a JSON-RPC message to `/mcp` with the Streamable-HTTP headers + an optional bearer/origin. */
async function rpc(
  body: unknown,
  options: { token?: string; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    origin: options.origin ?? ORIGIN,
  };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;

  return fetch(`${h.base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** Unwrap a `tools/call` result: the SDK wraps the tool's JSON in `result.content[0].text`. */
function toolResult<T>(payload: unknown): T {
  const wrapped = payload as { result?: { content?: { text?: string }[] } };

  return JSON.parse(wrapped.result?.content?.[0]?.text ?? "null") as T;
}

beforeAll(async () => {
  const { db: handle, close } = await openSqlite();
  const idp = await createDemoIdp({ issuer: ISSUER });

  const { app, resource, deployments } = await buildApp({
    handle,
    issuer: idp.issuer,
    jwks: idp.jwks,
    baseUrl: BASE_URL,
    rolesOf: demoRolesOf,
    allowedOrigins: [ORIGIN],
  });

  const server = await serve(app, { port: 0 });

  h = {
    base: `http://127.0.0.1:${server.port}`,
    resource,
    viewerToken: await idp.issue({
      subject: "viewer@example.com",
      scope: "mcp:read",
      audience: resource,
    }),
    operatorToken: await idp.issue({
      subject: "operator@example.com",
      scope: "mcp:read mcp:write",
      audience: resource,
    }),
    wrongAudienceToken: await idp.issue({
      subject: "operator@example.com",
      scope: "mcp:read mcp:write",
      audience: "https://other-service.example.test/mcp",
    }),
    server,
    close,
    deployments: deployments as { app: string; ref: string }[],
  };
});

afterAll(async () => {
  await h.server.close();
  h.close();
});

describe("authenticated remote MCP server, over live HTTP", () => {
  it("serves RFC 9728 Protected Resource Metadata", async () => {
    const res = await fetch(`${h.base}/.well-known/oauth-protected-resource`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: h.resource,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp:read", "mcp:write"],
    });
  });

  it("refuses a request with no bearer token (401 + WWW-Authenticate -> metadata)", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("refuses a valid token minted for another audience (the confused-deputy guard)", async () => {
    const res = await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { token: h.wrongAudienceToken },
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("refuses a cross-site origin before reading the token (403)", async () => {
    const res = await rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      { token: h.operatorToken, origin: "https://evil.example.test" },
    );

    expect(res.status).toBe(403);
  });

  it("lets a viewer (mcp:read) list the tools and inspect the routes", async () => {
    const list = await rpc(
      { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
      { token: h.viewerToken },
    );
    expect(list.status).toBe(200);
    const tools =
      ((await list.json()) as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
    expect(tools.map((t) => t.name)).toContain("list_routes");

    const routes = await rpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "list_routes", arguments: {} },
      },
      { token: h.viewerToken },
    );
    expect(routes.status).toBe(200);
    const surfaced = toolResult<{ method: string; pattern: string }[]>(await routes.json());
    expect(surfaced).toContainEqual({ method: "POST", pattern: "/deployments" });
  });

  it("refuses a viewer's destructive handle_request (403 insufficient_scope) — no write", async () => {
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "handle_request",
          arguments: { method: "POST", path: "/deployments", body: { app: "web", ref: "v2" } },
        },
      },
      { token: h.viewerToken },
    );

    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(h.deployments).toHaveLength(0);
  });

  it("lets an operator (mcp:read mcp:write) drive a real deploy, visible over HTTP", async () => {
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "handle_request",
          arguments: { method: "POST", path: "/deployments", body: { app: "web", ref: "v2" } },
        },
      },
      { token: h.operatorToken },
    );
    expect(res.status).toBe(200);
    const appResponse = toolResult<{ status: number; body: string }>(await res.json());
    expect(appResponse.status).toBe(201);

    // The deploy the operator agent created is now visible over plain HTTP.
    const listed = await fetch(`${h.base}/deployments`);
    const { deployments } = (await listed.json()) as {
      deployments: { app: string; ref: string }[];
    };
    expect(deployments).toContainEqual(expect.objectContaining({ app: "web", ref: "v2" }));
  });
});
