import { describe, expect, it } from "vitest";

import { runPipeline } from "../src/index";

import type { AnyVoloResponse, VoloRequest, Middleware, Next } from "../src/index";

const request: VoloRequest = {
  method: "GET",
  path: "/",
  params: {},
  query: {},
  headers: {},
  body: undefined,
};

const dispatch = async (): Promise<AnyVoloResponse> => ({
  status: 200,
  headers: { "content-type": "text/plain" },
  body: "ok",
});

// A middleware that answers outright, never calling `next` — the short-circuit.
const block: Middleware = async () => ({ status: 403, headers: {}, body: "Forbidden" });

// A middleware that throws — the error-boundary fixtures below assert it
// propagates out of runPipeline unswallowed. Hoisted to module scope because
// they capture nothing.
const explode: Middleware = async () => {
  throw new Error("mw");
};

const explodeInner: Middleware = async () => {
  throw new Error("inner");
};

// A terminal dispatch that rejects — the innermost `next` failing.
const failingDispatch: Next = async () => {
  throw new Error("dispatch");
};

describe("runPipeline", () => {
  it("runs the dispatch verbatim with an empty middleware list", async () => {
    const response = await runPipeline([], request, dispatch);

    expect(response.status).toBe(200);
    expect(response.body).toBe("ok");
  });

  it("wraps the dispatch with a single middleware (onion in, then out)", async () => {
    const trace: string[] = [];

    const tag: Middleware = async (_req, next) => {
      trace.push("before");

      const response = await next();

      trace.push("after");

      return { ...response, headers: { ...response.headers, "x-tag": "1" } };
    };

    const response = await runPipeline([tag], request, dispatch);

    expect(response.headers["x-tag"]).toBe("1");
    expect(trace).toEqual(["before", "after"]);
  });

  it("runs middleware outermost-first, then unwinds in reverse", async () => {
    const trace: string[] = [];

    const outer: Middleware = async (_req, next) => {
      trace.push("outer-in");
      const response = await next();
      trace.push("outer-out");
      return response;
    };

    const inner: Middleware = async (_req, next) => {
      trace.push("inner-in");
      const response = await next();
      trace.push("inner-out");
      return response;
    };

    await runPipeline([outer, inner], request, dispatch);

    // First-listed is outermost: it enters first and exits last.
    expect(trace).toEqual(["outer-in", "inner-in", "inner-out", "outer-out"]);
  });

  it("short-circuits when a middleware never calls next", async () => {
    let reached = false;

    const sentinel: Middleware = async (_req, next) => {
      reached = true;
      return next();
    };

    const response = await runPipeline([block, sentinel], request, dispatch);

    expect(response.status).toBe(403);
    // The inner middleware (and the dispatch) never ran — the outer answered.
    expect(reached).toBe(false);
  });

  it("passes the request through to every middleware", async () => {
    const seen: string[] = [];

    const record: Middleware = async (req, next) => {
      seen.push(req.path);
      return next();
    };

    await runPipeline([record, record], { ...request, path: "/seen" }, dispatch);

    expect(seen).toEqual(["/seen", "/seen"]);
  });

  it("propagates a throwing middleware's rejection unswallowed (error boundary, not a hang)", async () => {
    // runPipeline wraps layers in plain async closures with no try/catch, so a
    // thrown middleware rejects the pipeline promise. The transport's
    // per-request boundary then maps it to a 500 — the request never hangs.
    await expect(runPipeline([explode], request, dispatch)).rejects.toThrow("mw");
  });

  it("surfaces an inner rejection through an outer middleware that does not catch it", async () => {
    const trace: string[] = [];

    // The outer awaits next() but wraps no try/catch, so the inner's rejection
    // tears straight through it — proving the onion does not silently absorb
    // failures from deeper layers.
    const outer: Middleware = async (_req, next) => {
      trace.push("outer-in");
      const response = await next();
      trace.push("outer-out");
      return response;
    };

    await expect(runPipeline([outer, explodeInner], request, dispatch)).rejects.toThrow("inner");

    // The outer entered but never unwound: its post-next code is unreachable
    // once the inner rejects, exactly as an uncaught throw should behave.
    expect(trace).toEqual(["outer-in"]);
  });

  it("propagates a rejection from the terminal dispatch", async () => {
    // The innermost `next` is the dispatch itself; its rejection must surface
    // the same way, with no middleware to intercept it.
    await expect(runPipeline([], request, failingDispatch)).rejects.toThrow("dispatch");
  });
});
