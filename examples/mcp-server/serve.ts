/**
 * Serve the authenticated MCP server over LIVE HTTP.
 *
 *   bun run examples/mcp-server/serve.ts
 *
 * Where run.ts dispatches the dance in-process, this boots the same app behind a real
 * node:http server (`@lesto/runtime`'s `serve`) and stays up so you can drive it by hand —
 * or point a real MCP client at it. On boot it mints a viewer and an operator token from
 * the demo IdP and prints copy-paste `curl`s for the whole governed flow.
 *
 * In production you delete the demo IdP, set `jwks` to your external IdP's `jwks_uri`, and
 * the agent's own OAuth client obtains the token — nothing else changes.
 */

import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";

import { buildApp, demoRolesOf } from "./src/app";
import { createDemoIdp } from "./src/idp";

const PORT = Number(process.env.PORT ?? 3000);
const ISSUER = "https://idp.example.test/";
const ORIGIN = `http://127.0.0.1:${PORT}`;

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const idp = await createDemoIdp({ issuer: ISSUER });

  const baseUrl = `http://127.0.0.1:${PORT}`;
  const { app, resource } = await buildApp({
    handle,
    issuer: idp.issuer,
    jwks: idp.jwks,
    baseUrl,
    rolesOf: demoRolesOf,
    allowedOrigins: [ORIGIN],
  });

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

  // serveWithGracefulShutdown owns the SIGINT + SIGTERM wiring, the double-signal guard, and a
  // force-exit backstop (see @lesto/runtime): `onShutdown` logs at the signal; `onClosed` closes
  // the db after in-flight requests drain.
  const server = await serveWithGracefulShutdown(app, {
    port: PORT,
    onShutdown: () => console.log("\nshutting down..."),
    onClosed: close,
  });
  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nMCP Resource Server listening on ${url}`);
  console.log(`  resource: ${resource}`);
  console.log(
    `  issuer:   ${idp.issuer} (demo IdP — swap for your external IdP's jwks_uri in production)\n`,
  );

  console.log(`# 1. Discover the issuer (RFC 9728 — no token needed):`);
  console.log(`curl -s ${url}/.well-known/oauth-protected-resource\n`);

  console.log(`# 2. No token -> 401 + WWW-Authenticate challenge:`);
  console.log(`curl -i -X POST ${url}/mcp -H 'origin: ${ORIGIN}' \\`);
  console.log(
    `  -H 'accept: application/json, text/event-stream' -H 'content-type: application/json' \\`,
  );
  console.log(`  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'\n`);

  console.log(`# 3. Viewer (mcp:read) lists tools — allowed:`);
  console.log(
    `curl -s -X POST ${url}/mcp -H 'origin: ${ORIGIN}' -H 'authorization: Bearer ${viewerToken}' \\`,
  );
  console.log(
    `  -H 'accept: application/json, text/event-stream' -H 'content-type: application/json' \\`,
  );
  console.log(`  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'\n`);

  console.log(`# 4. Viewer tries the destructive tool -> 403 insufficient_scope:`);
  console.log(
    `curl -i -X POST ${url}/mcp -H 'origin: ${ORIGIN}' -H 'authorization: Bearer ${viewerToken}' \\`,
  );
  console.log(
    `  -H 'accept: application/json, text/event-stream' -H 'content-type: application/json' \\`,
  );
  console.log(
    `  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"handle_request","arguments":{"method":"POST","path":"/deployments","body":{"app":"web","ref":"v2"}}}}'\n`,
  );

  console.log(`# 5. Operator (mcp:read mcp:write) drives the real deploy -> 201:`);
  console.log(
    `curl -s -X POST ${url}/mcp -H 'origin: ${ORIGIN}' -H 'authorization: Bearer ${operatorToken}' \\`,
  );
  console.log(
    `  -H 'accept: application/json, text/event-stream' -H 'content-type: application/json' \\`,
  );
  console.log(
    `  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"handle_request","arguments":{"method":"POST","path":"/deployments","body":{"app":"web","ref":"v2"}}}}'`,
  );
  console.log(`\n  then: curl -s ${url}/deployments   # the deploy the operator agent created`);
}

await main();
