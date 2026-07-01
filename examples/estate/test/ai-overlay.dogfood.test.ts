/**
 * The in-preview AI overlay dogfood (ADR 0033 Phase 1, increment 6 · L-d43dde63).
 *
 * estate's local dev runs through the framework's own `lesto dev` (see `package.json` —
 * `bun --bun lesto dev`, no hand-rolled dev loop): estate migrated its dev entry onto the
 * CLI's dev path (L-cfd434f4), so the dev-only in-preview AI overlay (ADR 0033) is wired by
 * the CLI BIN, not by an estate file. There is deliberately no bespoke
 * `examples/estate/dev.ts` carrying `CliDeps` seams, and the app-config layer
 * (`lesto.app.ts`) stays clean of dev wiring — this test grep-asserts that invariant so the
 * overlay never leaks into app assembly.
 *
 * This is the gallery-as-QA gate for the overlay. It drives estate's REAL app through
 * `run(["dev"])` — estate's own `lesto.app.ts` config + `lesto.sites.ts` zones — with the
 * SAME `aiOverlay` seam + `startDevMcp`→`dispatchDevTool` wiring the bin performs, and
 * proves, over estate's real routes:
 *
 *   1. INJECTION  — the dev HTML for a real estate route (`/lab`) carries the injected AI
 *      overlay `<script>` (the Cmd-K "Ask Claude" panel — it paints), the EXACT client
 *      string the bin bakes in (`aiOverlayClientScript`).
 *   2. ROUND-TRIP — a chat turn POSTed to the reserved, same-origin, token-gated
 *      `/__lesto_dev_ai` endpoint round-trips a read-only `describe_app` inspect over
 *      estate's REAL app structure (its `/mls` routes come back in the reply), audited and
 *      inspect-only — no mutation.
 *   3. FAIL-CLOSED — once the dev MCP plane is torn down the overlay's dispatch seam is
 *      cleared, so a turn fails closed to the inspect-only "not available" reply — never a
 *      browser-side write.
 *
 * SCOPE (deliberately honest): the overlay's LIVE dispatch is IN-PROCESS
 * (`dispatch(context, tools, "describe_app", {})` over the same governed, audited context
 * the bin builds) — exactly the bin's overlay wiring. The loopback MCP *transport* leg is
 * the sibling `dev-mcp.dogfood.test.ts`'s job (this file stands up no socket); this file
 * owns the ADR-0033 overlay leg. The production counterpart (`prod-no-dev-mcp.test.ts`)
 * pins that NONE of this — the `__lesto_dev_ai` endpoint or the overlay client string —
 * reaches the shipped artifact.
 */

import { afterEach, describe, expect, it } from "vitest";

import { aiOverlayClientScript, createDevState, run } from "@lesto/cli";
import type { CliDeps } from "@lesto/cli";
import { buildTools, dispatch } from "@lesto/mcp";
import type { LestoMcpContext, McpAuditRecord } from "@lesto/mcp";
import type { App } from "@lesto/kernel";
import type { LestoResponse } from "@lesto/web";

import appConfig from "../lesto.app";

/** The reserved same-origin dev path the overlay POSTs a chat turn to (the bin's constant). */
const DEV_AI_ENDPOINT = "/__lesto_dev_ai";

/** The per-session token the endpoint gates on (over MIN_DEV_TOKEN_LENGTH). */
const DEV_TOKEN = "estate-ai-token-".repeat(4);

/** A same-origin, token-bearing chat turn — the shape the injected overlay client sends. */
const AUTHED_TURN = {
  origin: "http://localhost:5173",
  host: "localhost:5173",
  "x-lesto-dev-token": DEV_TOKEN,
} as const;

/**
 * A `serve` fake that never binds a socket but captures the app handle `runDev` fronts —
 * the outermost handle `withAiEndpoint` + `withTrailingScript` wrap — so the test can drive
 * a real GET (to see the injected overlay) and a real POST to the dev endpoint against it.
 */
function capturingServe(): { serve: CliDeps["serve"]; app: () => App } {
  let captured: App | undefined;

  const serve = ((app: App) => {
    captured = app;

    return Promise.resolve({ port: 0, close: () => Promise.resolve() });
  }) as unknown as CliDeps["serve"];

  return {
    serve,
    app: () => {
      if (captured === undefined) throw new Error("serve was never called");

      return captured;
    },
  };
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

/** Drain an HTML or JSON `LestoResponse` body (string or stream) to a string. */
async function bodyText(response: LestoResponse): Promise<string> {
  if (typeof response.body === "string") return response.body;

  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  let out = "";
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    out += decoder.decode(read.value, { stream: true });
  }

  return out + decoder.decode();
}

/** Read a `{ reply }` JSON body back to its `reply` string. */
async function replyOf(response: LestoResponse): Promise<string> {
  return (JSON.parse(await bodyText(response)) as { reply: string }).reply;
}

let drain: (() => Promise<void>) | undefined;

afterEach(async () => {
  // Run the installed shutdown between cases (clears the overlay's dispatch seam, drains
  // the non-binding dev server) so no case leaks the wired dispatch into the next.
  await drain?.();
  drain = undefined;
});

describe("estate `lesto dev` — the in-preview AI overlay, dogfooded end-to-end", () => {
  it("injects the overlay into real dev HTML and round-trips a read-only describe_app inspect", async () => {
    const audited: McpAuditRecord[] = [];

    // A MUTABLE overlay seam carrying the EXACT client string the bin bakes in. `startDevMcp`
    // sets `dispatchDevTool` on it IN PLACE once the plane is up (and clears it on teardown) —
    // mirroring the bin, where the overlay lights up exactly when the dev MCP plane is running.
    const aiOverlay: NonNullable<CliDeps["aiOverlay"]> = {
      script: aiOverlayClientScript({ endpoint: DEV_AI_ENDPOINT, token: DEV_TOKEN }),
      endpoint: DEV_AI_ENDPOINT,
      token: DEV_TOKEN,
    };

    const serve = capturingServe();

    await run(["dev"], {
      ...inertDeps(),
      // estate's REAL project entrypoint — the same `lesto.app.ts` `lesto dev` loads.
      loadApp: () => Promise.resolve(appConfig),
      loadSites: () => import("../lesto.sites").then((module) => module.default),
      serve: serve.serve,
      devState: createDevState(),
      aiOverlay,
      regenerateRoutes: () => Promise.resolve({ path: "src/routes.gen.ts", count: 10 }),
      // Stand the governed dev context up over the live app + ring and wire the overlay's LIVE
      // dispatch IN PLACE — the SAME `dispatch(context, tools, turn.tool, {})` the bin runs, over
      // the same read-only, audited context. No loopback socket: the overlay dispatch is
      // in-process (the transport leg is the sibling dogfood's job).
      startDevMcp: ({ app, routes, devState: ring }) => {
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

        const tools = buildTools(context);
        aiOverlay.dispatchDevTool = (turn) => dispatch(context, tools, turn.tool, {});

        return Promise.resolve({
          close: () => {
            // Clear the overlay's dispatch first, so a turn racing teardown fails closed.
            aiOverlay.dispatchDevTool = undefined;

            return Promise.resolve();
          },
        });
      },
      installShutdown: (teardown) => {
        drain = teardown;
      },
      out: () => undefined,
    });

    const served = serve.app();

    // 1. INJECTION — a real estate route renders live in dev, and the AI overlay rides in as a
    //    trailing `<script>`: the exact client string (its root id + header), pointing at the
    //    reserved dev endpoint. Proves the overlay paints over estate's OWN app, not a fixture.
    const html = await bodyText(await served.handle("GET", "/lab"));
    expect(html).toContain("__lesto_ai_overlay__");
    expect(html).toContain("Lesto dev · Ask Claude (inspect-only)");
    expect(html).toContain(DEV_AI_ENDPOINT);

    // 2. ROUND-TRIP — a same-origin, token-gated chat turn dispatches the fixed read-only inspect
    //    tool (`describe_app`) over estate's REAL app: its `/mls` routes come back in the reply,
    //    the developer's prompt is echoed, and the surface is labelled inspect-only.
    const answer = await served.handle("POST", DEV_AI_ENDPOINT, {
      headers: AUTHED_TURN,
      body: { prompt: "what does this app expose?", route: "/lab" },
    });
    expect(answer.status).toBe(200);

    const reply = await replyOf(answer);
    expect(reply).toContain("what does this app expose?");
    expect(reply).toContain("/mls"); // a REAL estate route, from `describe_app`'s route map
    expect(reply).toContain("Inspect-only");

    // The dispatch went through the governed, audited tool path — a read-only `describe_app`,
    // recorded ok. This is the overlay acting as an in-process client of the dev MCP plane.
    expect(audited.map((record) => record.tool)).toEqual(["describe_app"]);
    expect(audited.every((record) => record.outcome === "ok")).toBe(true);

    // 3. FAIL-CLOSED — tear the plane down (clears the overlay's dispatch seam) and a turn now
    //    paints the inspect-only "not available" reply, never a browser-side write.
    await drain?.();
    drain = undefined;

    const closed = await served.handle("POST", DEV_AI_ENDPOINT, {
      headers: AUTHED_TURN,
      body: { prompt: "still there?", route: "/lab" },
    });
    expect(closed.status).toBe(200);
    expect(await replyOf(closed)).toContain("not available");
  }, 30_000);

  it("keeps the dev-only overlay seams OUT of estate's app-config layer (lesto.app.ts)", async () => {
    // The invariant the stale "wire estate's dev.ts" premise resolved to: estate runs
    // `lesto dev`, so the `aiOverlay` / `dispatchDevTool` seams are the CLI bin's job — they
    // must never appear in the canonical app-assembly file, which is import-shared by the
    // production Worker. (The whole-tree prod scan in `prod-no-dev-mcp.test.ts` backs the
    // broader "no dev surface ships" claim; this pins the one file most likely to drift.)
    const appConfigSource = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../lesto.app.ts", import.meta.url), "utf8"),
    );

    expect(appConfigSource).not.toContain("aiOverlay");
    expect(appConfigSource).not.toContain("dispatchDevTool");
  });
});
