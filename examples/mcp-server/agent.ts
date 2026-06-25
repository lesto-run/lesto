/**
 * A REAL MCP client completes the dance over live HTTP.
 *
 *   bun run examples/mcp-server/agent.ts
 *
 * Where run.ts drives the `/mcp` route with hand-built JSON-RPC and serve.ts prints curls,
 * THIS connects the actual `@modelcontextprotocol/sdk` `Client` — the same client library
 * Claude/Cursor/MCP-Inspector use — over `StreamableHTTPClientTransport` to a live Lesto MCP
 * server, carrying a real signed bearer from the demo IdP. It proves genuine agent interop
 * through the OAuth-gated transport: the initialize handshake, `listTools`, and `callTool`
 * all succeed for an operator; the scope ceiling refuses a viewer's destructive call; an
 * unauthenticated client is turned away.
 *
 * This is the external-IdP slice of the MA-5 "real agent completes the dance" proof (the
 * full in-house-issuer OAuth flow is the deferred ADR 0029 path).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { openSqlite, serve } from "@lesto/runtime";

import { buildApp, demoRolesOf } from "./src/app";
import { createDemoIdp } from "./src/idp";

const BASE_URL = "http://mcp.example.test";
const ISSUER = "https://idp.example.test/";

/** Connect a real MCP client to `${base}/mcp`, presenting `token` as a bearer (or none). */
async function connect(base: string, token: string | undefined): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    // A non-browser agent presents its bearer on the Authorization header and sends no
    // Origin (the server allows an absent Origin — the rebinding guard is browser-only).
    requestInit: token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
  });

  const client = new Client({ name: "demo-agent", version: "0.0.0" }, { capabilities: {} });
  // `exactOptionalPropertyTypes` vs the SDK: the client transport's `get sessionId(): string |
  // undefined` doesn't satisfy `Transport`'s `sessionId?: string`; it IS a Transport, so cast.
  await client.connect(transport as Transport);

  return client;
}

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();
  const idp = await createDemoIdp({ issuer: ISSUER });

  const { app, resource } = await buildApp({
    handle,
    issuer: idp.issuer,
    jwks: idp.jwks,
    baseUrl: BASE_URL,
    rolesOf: demoRolesOf,
    allowedOrigins: [],
  });

  const server = await serve(app, { port: 0 });
  const base = `http://127.0.0.1:${server.port}`;

  const operatorToken = await idp.issue({
    subject: "operator@example.com",
    scope: "mcp:read mcp:write",
    audience: resource,
  });
  const viewerToken = await idp.issue({
    subject: "viewer@example.com",
    scope: "mcp:read",
    audience: resource,
  });

  // 1. The operator agent connects (initialize handshake) and lists the tools.
  const operator = await connect(base, operatorToken);
  const { tools } = await operator.listTools();
  console.log(`operator connected — tools/list -> ${tools.map((t) => t.name).join(", ")}`);

  // 2. It inspects the routes (read-only) ...
  const routes = await operator.callTool(
    { name: "list_routes", arguments: {} },
    CallToolResultSchema,
  );
  console.log(`operator list_routes -> ${(routes.content as { text: string }[])[0]?.text}`);

  // 3. ... then drives a real deploy (operator-only).
  const deployed = await operator.callTool(
    {
      name: "handle_request",
      arguments: { method: "POST", path: "/deployments", body: { app: "web", ref: "v2" } },
    },
    CallToolResultSchema,
  );
  console.log(
    `operator handle_request POST /deployments -> ${(deployed.content as { text: string }[])[0]?.text}`,
  );
  await operator.close();

  // 4. A viewer agent connects and lists fine, but the destructive call is refused (403).
  const viewer = await connect(base, viewerToken);
  await viewer.listTools();
  try {
    await viewer.callTool({
      name: "handle_request",
      arguments: { method: "POST", path: "/deployments", body: { app: "web", ref: "v3" } },
    });
    console.log("viewer handle_request -> UNEXPECTEDLY ALLOWED");
  } catch (error) {
    console.log(`viewer handle_request -> refused (${(error as Error).message})`);
  }
  await viewer.close();

  // 5. An unauthenticated agent can't even connect.
  try {
    await connect(base, undefined);
    console.log("anonymous connect -> UNEXPECTEDLY ALLOWED");
  } catch (error) {
    console.log(`anonymous connect -> refused (${(error as Error).message})`);
  }

  await server.close();
  close();
}

await main();
