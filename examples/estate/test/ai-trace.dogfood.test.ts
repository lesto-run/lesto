/**
 * Estate's AI-route tracing dogfood (ADR 0031 Phase 2 / Inc 4).
 *
 * The sibling `tracing.test.ts` proves db/identity/client-error events become
 * child spans of the request span. This proves the agent tier joins the SAME
 * trace: one authenticated `POST /mls/api/assistant` drives a `runAgent` loop,
 * and its `ai.generate` + `ai.tool` spans carry the in-flight `http.request`
 * span as parent — the in-request agent join, now real because a route consumes
 * `@lesto/ai`. The full illustrative trace the plan names —
 * `http.request → ai.generate → ai.tool → db.query` — is asserted to be one
 * trace (the authed route's identity read is the `db.query` leg).
 *
 * The wiring is the production wiring: ONE `Tracer`/exporter, with both the
 * db/identity seams AND the `Tracer`→`AgentTracer` adapter parenting on
 * `currentRequestSpan`, exactly as `serve.ts` builds them. The agent runs the
 * committed local demo model (deterministic — one `searchListings` call, then a
 * grounded answer), so no network and no secret is involved.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "@lesto/kernel";
import { currentRequestSpan, runWithContext } from "@lesto/web";
import { createTraces, InMemoryExporter, Tracer } from "@lesto/observability";
import type { CurrentSpan, SpanData } from "@lesto/observability";

import { buildAppConfig } from "../src/app";
import { agentTracerFrom } from "../src/assistant";
import { DEFAULT_DEMO } from "../src/identity";

/** A same-origin form POST — the Fetch-Metadata signal `originCheck` reads to admit it. */
const SAME_ORIGIN_FORM = {
  "content-type": "application/x-www-form-urlencoded",
  "sec-fetch-site": "same-origin",
};

/** A same-origin JSON POST — the assistant route reads its `prompt` from the parsed body. */
const SAME_ORIGIN_JSON = {
  "content-type": "application/json",
  "sec-fetch-site": "same-origin",
};

/** Pull the session cookie's `name=value` out of a (possibly multi-value) Set-Cookie header. */
function cookieFrom(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;

  return (first ?? "").split(";")[0] ?? "";
}

describe("estate AI-route tracing dogfood", () => {
  it("the ai.generate + ai.tool spans parent on the in-flight http.request span", async () => {
    // ONE tracer/exporter, wired the production way: the seams AND the AI adapter
    // both parent on `currentRequestSpan`, so every span of a request joins its
    // trace. The agent runs the committed local demo model.
    const exporter = new InMemoryExporter();
    const tracer = new Tracer({ exporter });

    const traces = createTraces({
      tracer,
      flush: async () => {},
      currentSpan: currentRequestSpan as CurrentSpan,
    });

    const app = await createApp(
      await buildAppConfig("a".repeat(32), traces.seams, { tracer: agentTracerFrom(tracer) }),
    );

    // Sign in (outside any request span) to unlock the authed concierge route.
    const signIn = await app.handle("POST", "/mls/api/sign-in", {
      headers: SAME_ORIGIN_FORM,
      body: new URLSearchParams({
        email: DEFAULT_DEMO.email,
        password: DEFAULT_DEMO.password,
      }).toString(),
    });
    const cookie = cookieFrom(signIn.headers["Set-Cookie"] ?? signIn.headers["set-cookie"]);
    expect(cookie).toContain("lesto_session");

    // The request span the runtime would publish for the assistant POST. We run
    // the request inside its context, exactly as the node server does.
    const root = tracer.startSpan("http.request");

    const response = await runWithContext({ requestId: "r-ai", span: root }, () =>
      app.handle("POST", "/mls/api/assistant", {
        headers: { ...SAME_ORIGIN_JSON, cookie },
        body: { prompt: "Show me homes in Malibu" },
      }),
    );

    expect(response.status).toBe(200);

    // The agent answered from the tool — the local model grounds its reply in the
    // one listing whose neighborhood the prompt mentions.
    const answer = (JSON.parse(response.body) as { answer: string }).answer;
    expect(answer).toContain("Malibu Cliffside");

    const generates = exporter.spans.filter((s) => s.name === "ai.generate");
    const tools = exporter.spans.filter((s) => s.name === "ai.tool");

    // The local demo model runs two turns (search → answer) with one tool call.
    expect(generates).toHaveLength(2);
    expect(tools).toHaveLength(1);

    // THE JOIN this dogfood proves: every AI span is a CHILD of the request span.
    for (const span of [...generates, ...tools]) {
      expect(span.traceId).toBe(root.data.traceId);
      expect(span.parentSpanId).toBe(root.data.spanId);
    }

    // The ai.generate span carries the model id and token usage (attributes land
    // on the emitted span — the adapter did not silently drop the bag).
    const generate = generates[0] as SpanData;
    expect(generate.attributes["ai.model"]).toBe("lesto-local-demo");
    expect(generate.attributes["ai.usage.input_tokens"]).toBeTypeOf("number");

    // The ai.tool span names the tool the agent invoked, and ended ok.
    const tool = tools[0] as SpanData;
    expect(tool.attributes["ai.tool.name"]).toBe("searchListings");
    expect(tool.status).toBe("ok");

    // The full illustrative trace really is one trace: the authed route's identity
    // read produced a db.query span on the SAME trace as the AI spans. (Sign-in ran
    // its own db queries outside this request span, so filter to the request trace.)
    const queriesOnTrace = exporter.spans.filter(
      (s) => s.name === "db.query" && s.traceId === root.data.traceId,
    );
    expect(queriesOnTrace.length).toBeGreaterThan(0);
  });

  it("refuses the concierge for a signed-out caller (401) and emits no AI spans", async () => {
    const exporter = new InMemoryExporter();
    const tracer = new Tracer({ exporter });

    const app = await createApp(
      await buildAppConfig("b".repeat(32), undefined, { tracer: agentTracerFrom(tracer) }),
    );

    const response = await app.handle("POST", "/mls/api/assistant", {
      headers: SAME_ORIGIN_JSON,
      body: { prompt: "Show me homes" },
    });

    expect(response.status).toBe(401);
    expect(exporter.spans.filter((s) => s.name.startsWith("ai."))).toHaveLength(0);
  });

  it("without a tracer wired, the concierge still answers (span emission is a clean no-op)", async () => {
    // The `lesto dev` / no-OTLP path: no adapter injected, so `runAgent` emits no
    // spans and the route is byte-unchanged — it just answers.
    const app = await createApp(await buildAppConfig("c".repeat(32)));

    const signIn = await app.handle("POST", "/mls/api/sign-in", {
      headers: SAME_ORIGIN_FORM,
      body: new URLSearchParams({
        email: DEFAULT_DEMO.email,
        password: DEFAULT_DEMO.password,
      }).toString(),
    });
    const cookie = cookieFrom(signIn.headers["Set-Cookie"] ?? signIn.headers["set-cookie"]);

    const response = await app.handle("POST", "/mls/api/assistant", {
      headers: { ...SAME_ORIGIN_JSON, cookie },
      body: { prompt: "What's in Bel Air?" },
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { answer: string; steps: string[][] };
    expect(body.answer).toContain("Bel Air Glen Estate");
    // The agent took one step, invoking the search tool.
    expect(body.steps).toEqual([["searchListings"]]);
  });
});
