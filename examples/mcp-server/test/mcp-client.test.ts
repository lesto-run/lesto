/**
 * The headline proof (MA-5, external-IdP slice): a REAL MCP client completes the dance.
 *
 * Where mcp-server.test.ts drives the wire with hand-built JSON-RPC, this connects the
 * actual `@modelcontextprotocol/sdk` `Client` — the same library Claude/Cursor/MCP-Inspector
 * use — over `StreamableHTTPClientTransport` to a LIVE Lesto MCP server, presenting a real
 * signed bearer from the demo IdP. It proves genuine agent interop through the OAuth-gated
 * transport, end to end, as a CI gate.
 *
 * What it asserts:
 *   - An operator agent connects (the initialize handshake), `listTools`, inspects routes,
 *     and drives a real `POST /deployments` via `callTool` — with NO transport errors (the
 *     client's optional GET-SSE probe gets a clean 405).
 *   - A viewer agent connects + lists fine, but its destructive `callTool` is REFUSED (the
 *     scope ceiling, surfaced to the client as a transport error).
 *   - An unauthenticated agent cannot even connect (401).
 *
 * The full in-house-issuer OAuth flow (discovery → DCR → PKCE → consent) is the deferred
 * ADR 0029 path; this is the external-IdP variant of "a real agent completes the dance".
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openSqlite, serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";

import { buildApp, demoRolesOf } from "../src/app";
import { createDemoIdp } from "../src/idp";

const BASE_URL = "http://mcp.example.test";
const ISSUER = "https://idp.example.test/";

interface Harness {
  base: string;
  resource: string;
  operatorToken: string;
  viewerToken: string;
  server: Server;
  close: () => void;
}

let h: Harness;

/**
 * A text tool result, parsed: handlers return JSON in `content[0].text`. Takes `unknown`
 * because `callTool`'s typed result is a `content` | legacy-`toolResult` union; the
 * `CallToolResultSchema` passed at the call site validates the real shape at runtime.
 */
function toolJson<T>(result: unknown): T {
  const content = (result as { content?: { text?: string }[] }).content;

  return JSON.parse(content?.[0]?.text ?? "null") as T;
}

/** Connect a real MCP client to the live server, presenting `token` as a bearer (or none). */
async function connect(token: string | undefined): Promise<{ client: Client; errors: unknown[] }> {
  const errors: unknown[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(`${h.base}/mcp`), {
    requestInit: token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
  });

  const client = new Client({ name: "test-agent", version: "0.0.0" }, { capabilities: {} });
  client.onerror = (error) => errors.push(error);
  // `exactOptionalPropertyTypes` vs the SDK: the client transport's `get sessionId(): string |
  // undefined` doesn't satisfy `Transport`'s `sessionId?: string`; it IS a Transport, so cast.
  try {
    await client.connect(transport as Transport);
  } catch (error) {
    // A refused connect (e.g. 401) must not leak the transport's socket/AbortController —
    // close before re-throwing so CI's stricter handle tracking sees a clean teardown.
    await client.close();
    throw error;
  }

  return { client, errors };
}

beforeAll(async () => {
  const { db: handle, close } = await openSqlite();
  const idp = await createDemoIdp({ issuer: ISSUER });

  const { app, resource } = await buildApp({
    handle,
    issuer: idp.issuer,
    jwks: idp.jwks,
    baseUrl: BASE_URL,
    rolesOf: demoRolesOf,
    // A non-browser agent sends no Origin; the server allows an absent Origin (the
    // rebinding guard is browser-only), so no allowlist entry is needed here.
    allowedOrigins: [],
  });

  const server = await serve(app, { port: 0 });

  h = {
    base: `http://127.0.0.1:${server.port}`,
    resource,
    operatorToken: await idp.issue({
      subject: "operator@example.com",
      scope: "mcp:read mcp:write",
      audience: resource,
    }),
    viewerToken: await idp.issue({
      subject: "viewer@example.com",
      scope: "mcp:read",
      audience: resource,
    }),
    server,
    close,
  };
});

afterAll(async () => {
  await h.server.close();
  h.close();
});

describe("a real MCP client completes the dance (external-IdP slice of MA-5)", () => {
  it("an operator agent connects, lists tools, inspects routes, and drives a real deploy", async () => {
    const { client, errors } = await connect(h.operatorToken);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["list_routes", "handle_request"]),
      );

      const routes = toolJson<{ method: string; pattern: string }[]>(
        await client.callTool({ name: "list_routes", arguments: {} }, CallToolResultSchema),
      );
      expect(routes).toContainEqual({ method: "POST", pattern: "/deployments" });

      const deployed = toolJson<{ status: number; body: string }>(
        await client.callTool(
          {
            name: "handle_request",
            arguments: { method: "POST", path: "/deployments", body: { app: "web", ref: "v2" } },
          },
          CallToolResultSchema,
        ),
      );
      expect(deployed.status).toBe(201);
      expect(JSON.parse(deployed.body)).toMatchObject({ deployment: { app: "web", ref: "v2" } });

      // The deploy is visible over plain HTTP — the agent really mutated app state.
      const listed = await fetch(`${h.base}/deployments`);
      const { deployments } = (await listed.json()) as { deployments: { ref: string }[] };
      expect(deployments).toContainEqual(expect.objectContaining({ ref: "v2" }));
    } finally {
      await client.close();
    }

    // After teardown (no in-flight stream left to fault): the optional GET-SSE probe got a
    // clean 405, not a 404 — so NO transport error ever fired.
    expect(errors).toEqual([]);
  });

  it("a viewer agent lists tools but is refused the destructive call (scope ceiling)", async () => {
    const { client } = await connect(h.viewerToken);

    try {
      // Reading is fine.
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("list_routes");

      // The destructive tool is refused at the transport with the scope ceiling's 403 —
      // asserting the CODE (not just "throws") so a stray 500 can't false-pass this.
      await expect(
        client.callTool({
          name: "handle_request",
          arguments: { method: "POST", path: "/deployments", body: { app: "web", ref: "v3" } },
        }),
      ).rejects.toMatchObject({ code: 403 });
    } finally {
      await client.close();
    }
  });

  it("an unauthenticated agent cannot connect (401)", async () => {
    // `connect` closes the transport on the rejection, so no socket leaks; assert the CODE
    // so this proves a 401 specifically (not any failure to connect).
    await expect(connect(undefined)).rejects.toMatchObject({ code: 401 });
  });
});
