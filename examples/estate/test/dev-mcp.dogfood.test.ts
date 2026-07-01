/**
 * The dev MCP control-plane dogfood (ADR 0032 Phase 1, increment 8 · L-cfd434f4).
 *
 * estate's local dev now runs through the framework's own `lesto dev` (see
 * `package.json` — `bun --bun lesto dev`, no hand-rolled dev loop), so the dev MCP
 * server actually appears on estate's dev path. This test proves the agent-native
 * dev loop end-to-end on estate's REAL app: it drives `run(["dev"])` with estate's
 * real `lesto.app.ts` config + a real dev-state ring, stands a REAL loopback MCP
 * server over that ring (exactly what the `lesto dev` bin wires), and reads the
 * three dev tools back over the wire.
 *
 *   - `get_recent_requests` → the access-log entry `serve`'s `logRequest` seam fed.
 *   - `tail_logs`           → the route-refresh dev-loop line.
 *   - `get_dev_diagnostics` → the `DevError` a failed route re-load recorded.
 *
 * It also asserts the transport's security floor (a foreign-Origin call is refused
 * before any dispatch) and that every accepted call was audited — the governance
 * the control plane is built around.
 *
 * In-process by design (estate's whole suite is): the only socket is the loopback
 * MCP server on `127.0.0.1:0`, torn down on the captured shutdown drain. The live
 * `bun --bun lesto dev` path (real bin, real token mint, stderr URL) is verified by
 * hand against a running server; this is its deterministic regression gate, the
 * sibling of the committed CLI gate (`packages/cli/test/run.test.ts`) pointed at
 * estate's real app instead of a fake config.
 */

import { afterEach, describe, expect, it } from "vitest";

import { createDevState, run } from "@lesto/cli";
import type { CliDeps, DevError } from "@lesto/cli";
import { startMcpHttpServer } from "@lesto/mcp";
import type { LestoMcpContext, McpAuditRecord } from "@lesto/mcp";
import type { App } from "@lesto/kernel";

import appConfig from "../lesto.app";

/** The per-session token the loopback transport gates on (over MIN_DEV_TOKEN_LENGTH). */
const DEV_TOKEN = "estate-dev-token-".repeat(4);

/** A single access-log entry, the shape `serve`'s `logRequest` seam receives. */
const ACCESS_ENTRY = {
  method: "GET",
  path: "/mls/saved",
  status: 200,
  ms: 3,
  requestId: "req-estate-1",
} as const;

/**
 * A `serve` fake that never binds a socket but captures its options, so the test can
 * invoke the wired `logRequest` — the same seam a real served request would drive.
 */
function capturingServe(): {
  serve: CliDeps["serve"];
  logRequest: () => ((entry: typeof ACCESS_ENTRY) => void) | undefined;
} {
  let captured: { logRequest?: (entry: typeof ACCESS_ENTRY) => void } | undefined;

  const serve = ((
    _app: unknown,
    options?: { logRequest?: (entry: typeof ACCESS_ENTRY) => void },
  ) => {
    captured = options;

    return Promise.resolve({ port: 0, close: () => Promise.resolve() });
  }) as unknown as CliDeps["serve"];

  return { serve, logRequest: () => captured?.logRequest };
}

/** The required-but-unused `CliDeps` fields for a `dev` run (never reached off the dev path). */
function inertDeps(): Omit<CliDeps, "loadApp" | "serve" | "loadSites" | "out"> {
  return {
    buildContent: () => Promise.resolve([]),
    persistEntries: () => Promise.resolve({ persisted: 0 }),
    pruneEntries: () => Promise.resolve({ deleted: 0 }),
    deleteEntry: () => Promise.resolve({ deleted: 0 }),
    createEntry: () => Promise.resolve(),
    sink: () => () => Promise.resolve(),
    uploader: () => ({
      read: () => Promise.resolve(new Uint8Array()),
      put: () => Promise.resolve(),
    }),
    releaseStore: () => ({
      read: () => Promise.resolve(new Uint8Array()),
      put: () => Promise.resolve(),
      setCurrent: () => Promise.resolve(),
      getCurrent: () => Promise.resolve(undefined),
      listReleases: () => Promise.resolve([]),
    }),
    now: () => 0,
    cloudflare: {
      deploy: () => Promise.resolve({ url: undefined }),
      rollback: () => Promise.resolve(),
    },
    checkHealth: () => Promise.resolve(true),
  };
}

let drain: (() => Promise<void>) | undefined;

afterEach(async () => {
  // Tear the loopback MCP server + the (non-binding) dev server down between cases.
  await drain?.();
  drain = undefined;
});

describe("estate `lesto dev` — the dev MCP control plane, dogfooded end-to-end", () => {
  it("exposes get_recent_requests, tail_logs, and get_dev_diagnostics over the loopback transport", async () => {
    const devState = createDevState();
    const serve = capturingServe();
    const audited: McpAuditRecord[] = [];

    let mcpPort = 0;
    let onRouteChange: (() => void) | undefined;

    await run(["dev"], {
      ...inertDeps(),
      // estate's REAL project entrypoint — the same `lesto.app.ts` `lesto dev` loads.
      loadApp: () => Promise.resolve(appConfig),
      loadSites: () => import("../lesto.sites").then((module) => module.default),
      serve: serve.serve,
      devState,
      // Capture the route-change callback so the test can drive one deterministically.
      watchRoutes: (callback) => {
        onRouteChange = callback;

        return () => undefined;
      },
      regenerateRoutes: () => Promise.resolve({ path: "src/routes.gen.ts", count: 10 }),
      // A failing re-load records an `app-reload` DevError the diagnostics tool reads.
      reloadApp: () => Promise.reject(new Error("syntax error in app/routes/lab/gallery/page.tsx")),
      // Stand a REAL loopback dev MCP server over the ring — exactly what the bin wires.
      startDevMcp: async ({ app, routes, devState: ring }) => {
        const context: LestoMcpContext = {
          get app(): App {
            return app();
          },
          get routes(): readonly { method: string; pattern: string }[] {
            return routes();
          },
          mode: "read-only",
          devState: ring,
          audit: (record) => void audited.push(record),
        };

        const handle = await startMcpHttpServer(context, { token: DEV_TOKEN, port: 0 });

        mcpPort = handle.port;

        return { close: () => handle.close() };
      },
      installShutdown: (teardown) => {
        drain = teardown;
      },
      out: () => undefined,
    });

    // runDev has returned; fill the ring the way a live session would:
    //   1. a served request (the `logRequest` seam), and
    //   2. a watched route change → a "routes refreshed" log line + a failed re-load's DevError.
    serve.logRequest()?.(ACCESS_ENTRY);
    onRouteChange?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const base = `http://127.0.0.1:${mcpPort}/`;
    const call = (name: string, extraHeaders: Record<string, string> = {}): Promise<Response> =>
      fetch(base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-lesto-dev-token": DEV_TOKEN,
          ...extraHeaders,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      });

    // get_recent_requests → the access entry the serve seam fed the ring.
    const requests = (await toolResult(await call("get_recent_requests"))) as {
      requestId: string;
    }[];
    expect(requests.map((record) => record.requestId)).toContain("req-estate-1");

    // tail_logs → the route-refresh dev-loop activity line.
    const logs = (await toolResult(await call("tail_logs"))) as string[];
    expect(logs).toContain("routes refreshed: src/routes.gen.ts (10 route files)");

    // get_dev_diagnostics → the app-reload DevError the failed route re-load recorded.
    const diagnostics = (await toolResult(await call("get_dev_diagnostics"))) as DevError;
    expect(diagnostics.source).toBe("app-reload");
    expect(diagnostics.message).toContain("syntax error");

    // A foreign-Origin call is refused with MCP_DEV_ORIGIN_REJECTED before any dispatch.
    const rejected = await call("tail_logs", { origin: "https://evil.example" });
    expect(rejected.status).toBe(403);
    expect((await rejected.json()) as unknown).toMatchObject({ error: "MCP_DEV_ORIGIN_REJECTED" });

    // Every accepted call was audited; the rejected one never reached dispatch.
    expect(audited.map((record) => record.tool)).toEqual([
      "get_recent_requests",
      "tail_logs",
      "get_dev_diagnostics",
    ]);
    expect(audited.every((record) => record.outcome === "ok")).toBe(true);
  }, 30_000);
});

/** Unwrap an MCP `tools/call` response into the tool's parsed JSON payload. */
async function toolResult(response: Response): Promise<unknown> {
  const message = (await response.json()) as { result?: { content?: { text?: string }[] } };

  return JSON.parse(message.result?.content?.[0]?.text ?? "null");
}
