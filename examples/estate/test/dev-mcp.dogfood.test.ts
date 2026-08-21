/**
 * The dev MCP control-plane dogfood (ADR 0032 Phase 1, increment 8 · L-cfd434f4).
 *
 * estate's local dev now runs through the framework's own `lesto dev` (see
 * `package.json` — `bun --bun lesto dev`, no hand-rolled dev loop), so the dev MCP
 * server actually appears on estate's dev path. This test drives estate's REAL app
 * through `run(["dev"])` — estate's `lesto.app.ts` config + a real dev-state ring —
 * and reads the dev MCP surface back over a real loopback transport:
 *
 *   - `list_routes`         → estate's REAL routes (proves its config flows through runDev).
 *   - `get_recent_requests` → the access-log entry `serve`'s `logRequest` seam fed.
 *   - `tail_logs`           → the route-refresh dev-loop line.
 *   - `get_dev_diagnostics` → the `DevError` a failed route re-load recorded.
 *   - `get_trace`           → the request's SPANS, from the bounded dev trace ring
 *                             (ADR 0048 Phase 0.2), found by the very `requestId`
 *                             `get_recent_requests` reported — and with no OTLP
 *                             collector configured, which is the point of the ring.
 *
 * It also asserts the transport's security floor (a foreign-Origin call is refused
 * before any dispatch) and that every accepted call was audited — the governance
 * the control plane is built around.
 *
 * SCOPE (deliberately honest): this is an IN-PROCESS gate (estate's whole suite is) —
 * the only socket is the loopback MCP server on `127.0.0.1:0`, torn down on the
 * captured shutdown drain. It exercises `runDev`'s ring-filling + the real loopback
 * transport + the dev tools over estate's real app, complementing the CLI's own gate
 * (`packages/cli/test/run.test.ts`). It does NOT drive the `dev` npm script or the
 * bin's `startDevMcp` wiring (token mint, stderr banner) — those are coverage-excluded
 * and verified LIVE by hand (`bun --bun lesto dev` → curl the three tools). So it is
 * NOT a substitute for the live-bin smoke; it is the deterministic regression gate for
 * the surface estate now depends on.
 */

import { afterEach, describe, expect, it } from "vitest";

import { createDevState, run } from "@lesto/cli";
import type { CliDeps, DevError } from "@lesto/cli";
import { startMcpHttpServer } from "@lesto/mcp";
import type { LestoMcpContext, McpAuditRecord } from "@lesto/mcp";
import type { App } from "@lesto/kernel";

import appConfig from "../lesto.app";
import { inertDeps } from "./dev-harness";

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

/** The slice of `serve`'s options this dogfood drives by hand. */
interface CapturedServeOptions {
  logRequest?: (entry: typeof ACCESS_ENTRY & { traceId?: string }) => void;

  tracer?: {
    startSpan(name: string): {
      setAttribute(key: string, value: unknown): unknown;
      setStatus(status: string): unknown;
      end(): void;
      readonly data: { readonly traceId: string; readonly spanId: string };
    };
  };
}

/**
 * A `serve` fake that never binds a socket but captures its options, so the test can
 * invoke the wired `logRequest` — the same seam a real served request would drive —
 * and mint a span through the `tracer` `runDev` teed into the dev trace ring.
 */
function capturingServe(): {
  serve: CliDeps["serve"];
  options: () => CapturedServeOptions | undefined;
} {
  let captured: CapturedServeOptions | undefined;

  const serve = ((_app: unknown, options?: CapturedServeOptions) => {
    captured = options;

    return Promise.resolve({ port: 0, close: () => Promise.resolve() });
  }) as unknown as CliDeps["serve"];

  return { serve, options: () => captured };
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
    //   1. a served request (the `logRequest` seam),
    //   2. its request SPAN through the tracer runDev teed into the trace ring, and
    //   3. a watched route change → a "routes refreshed" log line + a failed re-load's DevError.
    // estate runs with no `LESTO_OTLP_URL` here — the dev span sink alone is what
    // turns tracing on (ADR 0048 Phase 0.2), which is exactly the claim under test.
    // The access line carries the `traceId` the runtime stamps on it beside the
    // request span, which is what `get_trace({ requestId })` resolves through.
    const requestSpan = serve.options()?.tracer?.startSpan("http.request");

    if (requestSpan === undefined) throw new Error("estate dev wired no tracer");

    serve.options()?.logRequest?.({ ...ACCESS_ENTRY, traceId: requestSpan.data.traceId });

    requestSpan.end();

    onRouteChange?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const base = `http://127.0.0.1:${mcpPort}/`;
    const call = (
      name: string,
      extraHeaders: Record<string, string> = {},
      args: Record<string, unknown> = {},
    ): Promise<Response> =>
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
          params: { name, arguments: args },
        }),
      });

    // list_routes → estate's REAL routes, proving its `lesto.app.ts` config (not a fake)
    // actually flowed through `runDev` into the live MCP context (the `routes` thunk).
    const routes = (await toolResult(await call("list_routes"))) as {
      method: string;
      pattern: string;
    }[];
    expect(routes.some((route) => route.pattern.startsWith("/mls"))).toBe(true);

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

    // get_trace → the span that request minted, found by the SAME requestId
    // `get_recent_requests` just reported (ADR 0048 Phase 0.2). One hop from "what
    // was served" to "what happened inside it", with no OTLP collector anywhere.
    const trace = (await toolResult(
      await call("get_trace", {}, { requestId: ACCESS_ENTRY.requestId }),
    )) as { retained: boolean; traceId: string; truncated: boolean; spans: { name: string }[] };

    expect(trace.retained).toBe(true);
    expect(trace.truncated).toBe(false);
    expect(trace.traceId).toBe(requestSpan.data.traceId);
    expect(trace.spans.map((span) => span.name)).toEqual(["http.request"]);

    // A foreign-Origin call is refused with MCP_DEV_ORIGIN_REJECTED before any dispatch.
    const rejected = await call("tail_logs", { origin: "https://evil.example" });
    expect(rejected.status).toBe(403);
    expect((await rejected.json()) as unknown).toMatchObject({ error: "MCP_DEV_ORIGIN_REJECTED" });

    // Every accepted call was audited; the rejected one never reached dispatch.
    expect(audited.map((record) => record.tool)).toEqual([
      "list_routes",
      "get_recent_requests",
      "tail_logs",
      "get_dev_diagnostics",
      "get_trace",
    ]);
    expect(audited.every((record) => record.outcome === "ok")).toBe(true);
  }, 30_000);
});

/** Unwrap an MCP `tools/call` response into the tool's parsed JSON payload. */
async function toolResult(response: Response): Promise<unknown> {
  const message = (await response.json()) as { result?: { content?: { text?: string }[] } };

  return JSON.parse(message.result?.content?.[0]?.text ?? "null");
}
