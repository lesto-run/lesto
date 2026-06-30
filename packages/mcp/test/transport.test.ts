import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Context } from "@lesto/web";
import type { AnyLestoResponse, LestoRequest, Next } from "@lesto/web";
import { definePolicy } from "@lesto/authz";

import { buildTools, createMcpHttpHandlers, mcpModeForScopes } from "../src";
import type { BearerSession, LestoMcpContext, McpHttpServerOptions } from "../src";

// These guard the *structural* acceptance criteria of the remote-MCP transport (OCP-9):
// the no-`kernel → mcp` edge and the confused-deputy defaults. The transport wiring
// itself is coverage-excluded; what must hold true about it is asserted here.

const here = fileURLToPath(new URL(".", import.meta.url));
const kernelDir = join(here, "..", "..", "kernel");

/** Every `.ts` file under a directory, recursively. */
function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return tsFilesUnder(path);

    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

/** A quoted-specifier (bare OR subpath) matcher, so backtick-quoted prose isn't a false hit. */
const importsForbidden = (pkg: string): RegExp => new RegExp(`["']${pkg}(/[^"']*)?["']`);

describe("no kernel → mcp edge (the app mounts the transport, never the kernel)", () => {
  it("@lesto/kernel does not depend on @lesto/mcp", () => {
    const pkg = JSON.parse(readFileSync(join(kernelDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    const everyDep = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };

    expect(everyDep["@lesto/mcp"]).toBeUndefined();
  });

  it("no @lesto/kernel source imports @lesto/mcp", () => {
    const offenders = tsFilesUnder(join(kernelDir, "src")).filter((file) =>
      readFileSync(file, "utf8").includes("@lesto/mcp"),
    );

    expect(offenders).toEqual([]);
  });
});

describe("@lesto/mcp injects, never imports — the forbidden edges (ADR 0031/0032)", () => {
  const mcpSrcDir = join(here, "..", "src");

  it("@lesto/mcp depends on neither @lesto/cli nor @lesto/observability", () => {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    const everyDep = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };

    // The dev-state reader (0032) is an injected structural seam; the `onSpan` seam
    // (0031) is injected too — `@lesto/mcp` opens no observability span itself.
    expect(everyDep["@lesto/cli"]).toBeUndefined();
    expect(everyDep["@lesto/observability"]).toBeUndefined();
  });

  it("no @lesto/mcp source imports @lesto/cli or @lesto/observability (incl. subpaths)", () => {
    const offenders = tsFilesUnder(mcpSrcDir).filter((file) => {
      const source = readFileSync(file, "utf8");

      return (
        importsForbidden("@lesto/cli").test(source) ||
        importsForbidden("@lesto/observability").test(source)
      );
    });

    expect(offenders).toEqual([]);
  });
});

describe("confused-deputy defaults on the MCP surface", () => {
  const context = {
    app: { handle: () => Promise.resolve({ status: 200, headers: {}, body: "" }) },
    routes: [],
    audit: () => {},
  } as unknown as LestoMcpContext;

  it("never exposes an impersonation tool", () => {
    const names = buildTools(context).map((tool) => tool.name);

    expect(names.some((name) => /impersonat|sudo|become|act[_-]?as/i.test(name))).toBe(false);
  });

  it("floors an unscoped (or read-only) token to read-only mode — no write without the write scope", () => {
    expect(mcpModeForScopes([], { writeScope: "mcp:write" })).toBe("read-only");
    expect(mcpModeForScopes(["mcp:read"], { writeScope: "mcp:write" })).toBe("read-only");
  });
});

// The handlers always return, so `next` is never invoked; a conformant stub satisfies the type.
const noop: Next = () => Promise.resolve({ status: 200, headers: {}, body: "" });

const MCP_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

/** A POST Context carrying a JSON-RPC body and the given headers. */
function post(body: unknown, headers: Record<string, string>): Context {
  const req: LestoRequest = { method: "POST", path: "/mcp", params: {}, query: {}, headers, body };

  return new Context(req);
}

/** A handler always answers; narrow away the `void` arm so a test reads its fields directly. */
function must(res: AnyLestoResponse | void): AnyLestoResponse {
  if (res === undefined) throw new Error("handler returned no response");

  return res;
}

// An in-process end-to-end drive of the (coverage-excluded) transport: this is the only
// proof the LestoRequest↔Fetch adapter, the `parsedBody` wiring, and the SDK happy path
// actually serve a real MCP request — no live server needed.
describe("createMcpHttpHandlers (end to end, in process)", () => {
  const operatorSession: BearerSession = {
    principal: { actor: "op", actorRoles: ["operator"] },
    scopes: ["mcp:read", "mcp:write"],
  };
  const readerSession: BearerSession = {
    principal: { actor: "viewer", actorRoles: ["viewer"] },
    scopes: ["mcp:read"],
  };

  const options: McpHttpServerOptions = {
    context: {
      app: { handle: () => Promise.resolve({ status: 200, headers: {}, body: "" }) },
      routes: [{ method: "GET", pattern: "/health" }],
      audit: () => {},
    } as unknown as McpHttpServerOptions["context"],
    authenticate: async (token) =>
      token === "op" ? operatorSession : token === "reader" ? readerSession : undefined,
    resource: "https://api.example.test/mcp",
    authorizationServers: ["https://issuer.example.test"],
    writeScope: "mcp:write",
    allowedOrigins: ["https://app.example.test"],
    resourceMetadataUrl: "https://api.example.test/.well-known/oauth-protected-resource",
  };

  const handlers = createMcpHttpHandlers(options);

  it("serves the RFC 9728 metadata document", async () => {
    const res = must(await handlers.metadata(post(undefined, {}), noop));

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body as string)).toMatchObject({
      resource: "https://api.example.test/mcp",
      authorization_servers: ["https://issuer.example.test"],
      bearer_methods_supported: ["header"],
    });
  });

  it("answers tools/list for an authenticated request with the live tool set", async () => {
    const c = post(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { ...MCP_HEADERS, authorization: "Bearer op" },
    );

    const res = must(await handlers.rpc(c, noop));

    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body as string) as {
      result?: { tools?: { name: string }[] };
    };
    expect(payload.result?.tools?.map((tool) => tool.name)).toContain("list_routes");
  });

  it("rejects a request with no bearer token (401 + WWW-Authenticate)", async () => {
    const c = post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, MCP_HEADERS);

    const res = must(await handlers.rpc(c, noop));

    expect(res.status).toBe(401);
    expect((res.headers as Record<string, string>)["www-authenticate"]).toContain(
      "resource_metadata=",
    );
  });

  it("refuses a destructive tools/call from a read-only token (403 insufficient_scope)", async () => {
    const c = post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "handle_request" } },
      { ...MCP_HEADERS, authorization: "Bearer reader" },
    );

    const res = must(await handlers.rpc(c, noop));

    expect(res.status).toBe(403);
    expect((res.headers as Record<string, string>)["www-authenticate"]).toContain(
      'error="insufficient_scope"',
    );
  });

  it("refuses a cross-site origin before reading the token (403)", async () => {
    const c = post(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { ...MCP_HEADERS, origin: "https://evil.test", authorization: "Bearer op" },
    );

    const res = must(await handlers.rpc(c, noop));

    expect(res.status).toBe(403);
  });
});

// OCP-7 end to end: a configured policy enforces the per-tool ROLE floor through the real
// handler chain, in INTERSECTION with the scope ceiling. The `rogue` token clears the scope
// ceiling (it carries the write scope → operator mode) but its subject's role does not hold the
// write permission — so the floor must refuse it, the gap OCP-7 closes.
describe("createMcpHttpHandlers — per-tool policy floor (OCP-7)", () => {
  // The operator role may write; the auditor may only read.
  const policy = definePolicy({
    roles: ["auditor", "operator"],
    can: {
      "mcp.read": ["auditor", "operator"],
      "mcp.write": ["operator"],
    },
  });

  // A genuine operator: write scope AND the operator role.
  const operatorSession: BearerSession = {
    principal: { actor: "op", actorRoles: ["operator"] },
    scopes: ["mcp:read", "mcp:write"],
  };
  // The gap OCP-7 closes: a write-scoped token whose subject is only an auditor. The scope
  // ceiling alone would let this drive a destructive tool; the policy floor must refuse it.
  const rogueSession: BearerSession = {
    principal: { actor: "rogue", actorRoles: ["auditor"] },
    scopes: ["mcp:read", "mcp:write"],
  };

  const options: McpHttpServerOptions = {
    context: {
      app: { handle: () => Promise.resolve({ status: 200, headers: {}, body: "" }) },
      routes: [{ method: "GET", pattern: "/health" }],
      audit: () => {},
    } as unknown as McpHttpServerOptions["context"],
    authenticate: async (token) =>
      token === "op" ? operatorSession : token === "rogue" ? rogueSession : undefined,
    resource: "https://api.example.test/mcp",
    authorizationServers: ["https://issuer.example.test"],
    writeScope: "mcp:write",
    allowedOrigins: ["https://app.example.test"],
    resourceMetadataUrl: "https://api.example.test/.well-known/oauth-protected-resource",
    policy,
    toolPermissions: { handle_request: "mcp.write" },
  };

  const handlers = createMcpHttpHandlers(options);

  const callHandleRequest = (token: string): Context =>
    post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "handle_request", arguments: { method: "GET", path: "/health" } },
      },
      { ...MCP_HEADERS, authorization: `Bearer ${token}` },
    );

  it("(a) lets a subject WITH the role + write scope drive the destructive tool", async () => {
    const res = must(await handlers.rpc(callHandleRequest("op"), noop));

    expect(res.status).toBe(200);
    // The tool's object result is ALSO returned as `structuredContent` — a client reads the
    // object directly, no double-parse — and the text block carries the same serialized JSON.
    const result = (JSON.parse(res.body as string) as { result: Record<string, unknown> }).result;
    expect(result.structuredContent).toEqual({ status: 200, headers: {}, body: "" });
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(
      result.structuredContent,
    );
  });

  it("(b) refuses a subject WITH the write scope but WITHOUT the role — even in operator mode (403)", async () => {
    const res = must(await handlers.rpc(callHandleRequest("rogue"), noop));

    expect(res.status).toBe(403);
    expect((res.headers as Record<string, string>)["www-authenticate"]).toContain(
      'error="insufficient_scope"',
    );
    // The challenge names the PERMISSION the floor demanded, not the scope.
    expect((res.headers as Record<string, string>)["www-authenticate"]).toContain(
      'scope="mcp.write"',
    );
  });

  it("still lets a non-mapped read tool through for the role-short subject (the floor is per-tool)", async () => {
    const c = post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_routes" } },
      { ...MCP_HEADERS, authorization: "Bearer rogue" },
    );

    const res = must(await handlers.rpc(c, noop));

    expect(res.status).toBe(200);
    // `list_routes` returns an ARRAY — no object form — so it stays text-only (no structuredContent).
    const result = (JSON.parse(res.body as string) as { result: Record<string, unknown> }).result;
    expect(result.structuredContent).toBeUndefined();
  });
});
