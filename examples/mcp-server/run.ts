/**
 * The whole authenticated remote-MCP journey, in-process, in one run.
 *
 *   bun run examples/mcp-server/run.ts
 *
 * It stands up the demo IdP, boots the MCP server over an in-memory database, then drives
 * the governed dance through the kernel over the REAL `/mcp` route — the same path a remote
 * agent's HTTP client would take against `serve.ts`. Every line printed is a response that
 * came back through `app.handle`.
 *
 * What to watch for:
 *   - **Discovery.** The RFC 9728 metadata at `/.well-known/oauth-protected-resource` names
 *     the issuer + resource a client needs to get a token.
 *   - **No token / wrong audience.** A request with no bearer is `401`; a token minted for a
 *     DIFFERENT resource is refused (the confused-deputy guard) even though its signature is
 *     valid.
 *   - **The scope ceiling.** A `mcp:read` token can `list_routes` but is refused (`403`
 *     `insufficient_scope`) when it tries the destructive `handle_request`; the `mcp:write`
 *     operator token drives a real `POST /deployments`.
 *   - **The audit trail.** Every dispatch — allowed or refused — is recorded with the actor.
 */

import { openSqlite } from "@lesto/runtime";

import { buildApp, demoRolesOf } from "./src/app";
import { createDemoIdp } from "./src/idp";

const BASE_URL = "http://mcp.example.test";
const ISSUER = "https://idp.example.test/";
const ORIGIN = "https://console.example.test";

/** Headers a well-formed MCP client sends: the bearer plus the Streamable-HTTP accept pair. */
function headers(
  token: string | undefined,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...extra,
  };
}

/** Drive one JSON-RPC call through the live `/mcp` route and return `{ status, payload }`. */
async function rpc(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  body: unknown,
  token: string | undefined,
  extra: Record<string, string> = {},
): Promise<{ status: number; payload: unknown }> {
  const response = await app.handle("POST", "/mcp", { headers: headers(token, extra), body });
  const text = response.body as string;

  return { status: response.status, payload: text === "" ? undefined : JSON.parse(text) };
}

/** Unwrap a `tools/call` result: the SDK wraps the tool's JSON in `result.content[0].text`. */
function toolResult<T>(payload: unknown): T {
  const wrapped = payload as { result?: { content?: { text?: string }[] } };

  return JSON.parse(wrapped.result?.content?.[0]?.text ?? "null") as T;
}

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  // The stand-in external IdP (delete in production; point `jwks` at your IdP's jwks_uri).
  const idp = await createDemoIdp({ issuer: ISSUER });

  const { app, resource, audit, deployments } = await buildApp({
    handle,
    issuer: idp.issuer,
    jwks: idp.jwks,
    baseUrl: BASE_URL,
    rolesOf: demoRolesOf,
    allowedOrigins: [ORIGIN],
  });

  // Two access tokens, as an external IdP would mint them for this resource.
  const viewerToken = await idp.issue({
    subject: "viewer@example.com",
    scope: "mcp:read",
    audience: resource,
  });
  const operatorToken = await idp.issue({
    subject: "operator@example.com",
    scope: "mcp:read mcp:write",
    audience: resource,
  });
  // A valid signature, but minted for SOME OTHER resource — must be refused.
  const wrongAudienceToken = await idp.issue({
    subject: "operator@example.com",
    scope: "mcp:read mcp:write",
    audience: "https://other-service.example.test/mcp",
  });

  // 1. Discovery — the RFC 9728 metadata a client reads first.
  const meta = await app.handle("GET", "/.well-known/oauth-protected-resource");
  console.log(`GET /.well-known/oauth-protected-resource -> ${meta.status}`);
  console.log("  metadata:", JSON.parse(meta.body as string), "\n");

  // 2. No token — a bare 401 pointing at the metadata.
  const anon = await rpc(
    app,
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    undefined,
  );
  console.log(
    `tools/list  (no token)            -> ${anon.status} ${anon.status === 401 ? "✔ challenged" : ""}`,
  );

  // 3. Valid signature, wrong audience — refused (confused-deputy guard).
  const crossAud = await rpc(
    app,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    wrongAudienceToken,
  );
  console.log(
    `tools/list  (wrong-audience token)-> ${crossAud.status} ${crossAud.status === 401 ? "✔ refused" : ""}`,
  );

  // 4. Cross-site origin — refused before the token is even read.
  const crossOrigin = await rpc(
    app,
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    operatorToken,
    { origin: "https://evil.example.test" },
  );
  console.log(
    `tools/list  (cross-site origin)   -> ${crossOrigin.status} ${crossOrigin.status === 403 ? "✔ blocked" : ""}\n`,
  );

  // 5. Viewer lists the tools, then inspects the routes — both allowed (read-only).
  const list = await rpc(
    app,
    { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
    viewerToken,
    { origin: ORIGIN },
  );
  const tools = (list.payload as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
  console.log(
    `tools/list  (viewer, mcp:read)    -> ${list.status}  tools: ${tools.map((t) => t.name).join(", ")}`,
  );

  const routes = await rpc(
    app,
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_routes", arguments: {} } },
    viewerToken,
    { origin: ORIGIN },
  );
  console.log(
    `tools/call list_routes (viewer)   -> ${routes.status}  ${JSON.stringify(toolResult(routes.payload))}\n`,
  );

  // 6. Viewer tries the destructive tool — refused by the scope ceiling (403).
  const denied = await rpc(
    app,
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "handle_request",
        arguments: { method: "POST", path: "/deployments", body: { app: "web", ref: "v2" } },
      },
    },
    viewerToken,
    { origin: ORIGIN },
  );
  console.log(
    `tools/call handle_request (viewer)-> ${denied.status} ${denied.status === 403 ? "✔ insufficient_scope — no write" : ""}`,
  );

  // 7. Operator drives the real write — a deployment lands.
  const deployed = await rpc(
    app,
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "handle_request",
        arguments: { method: "POST", path: "/deployments", body: { app: "web", ref: "v2" } },
      },
    },
    operatorToken,
    { origin: ORIGIN },
  );
  const response = toolResult<{ status: number; body: string }>(deployed.payload);
  console.log(
    `tools/call handle_request (op)    -> ${deployed.status}  app POST /deployments -> ${response.status}`,
  );
  console.log(`  deployed:`, deployments.at(-1), "\n");

  // 8. The governance trail those calls produced — every dispatch, with its actor.
  console.log(`MCP audit trail (${audit.length} dispatches):`);
  for (const record of audit) {
    console.log(`  ${record.actor ?? "<anon>"}  ${record.tool}  -> ${record.outcome}`);
  }

  close();
}

await main();
