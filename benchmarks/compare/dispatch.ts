/**
 * The in-process request-DISPATCH comparison: drive a request through each
 * framework's own socket-less dispatch path and time "request in → body string
 * out". This is the closest we get to a framework-vs-framework number without a
 * socket — useful here, but read the caveat below before quoting it.
 *
 *   - `lesto-bare` — `app.handle(method, path)` → a plain `LestoResponse` (`.body`),
 *                    with the secure stack OFF (see `lestoContenders` for why).
 *   - `hono`       — `app.fetch(Request)` → a web `Response`, drained with `.text()`.
 *   - `elysia`     — `app.handle(Request)` → a web `Response`, drained with `.text()`.
 *   - `fastify`    — `app.inject({ method, url })` (light-my-request) → `.body`.
 *
 * ⚠️ THE PATHS ARE NOT IDENTICAL WORK. `lesto-bare` returns a plain object;
 * Hono/Elysia construct AND drain a web `Response`; Fastify simulates the HTTP layer
 * via light-my-request. So a faster number can mean "did less," not "is faster." The
 * apples-to-apples comparison — same socket, same load generator, success-rate
 * and tail latency under real concurrency — is the real-server suite in
 * `../driver`. Treat this as an internal signal, never the headline. (Express has
 * no clean socket-less dispatch, so it appears only in the real-server suite.)
 *
 * Every contender is a dynamic import that SKIPS if the lib is absent, so this
 * runs with whatever `benchmarks/node_modules` has and reports the rest as
 * skipped — no install is mandatory to get a partial comparison. Parity (every
 * contender emits the SAME body bytes) is asserted in `dispatch.test.ts` via the
 * `read` probe — the bytes-parity lesson from the Platformatic "corrected results"
 * benchmark, where mismatched responses (compression) invalidated the numbers.
 */

import { jsonBody, jsonObject, plaintextBody } from "../apps/_contract.mjs";

import type { SampleSource } from "@lesto/bench";

/** The two in-process workloads this comparison times. */
export type DispatchWorkload = "json" | "plaintext";

/** One framework's dispatch surface: a `read` probe (for parity) + timed samples per workload. */
export interface DispatchContender {
  readonly name: string;
  /** Dispatch once and return the body string — used by the parity assertion. */
  readonly read: (workload: DispatchWorkload) => Promise<string>;
  readonly json: SampleSource;
  readonly plaintext: SampleSource;
}

/** Pre-build a reusable GET Request (no body to consume), so we time dispatch, not Request construction. */
function req(path: string): Request {
  return new Request(`http://bench.local${path}`);
}

/** Wrap a `read` into the two `SampleSource`s, discarding the body (the runner times the call). */
function samplesFrom(
  name: string,
  read: (workload: DispatchWorkload) => Promise<string>,
): DispatchContender {
  return {
    name,
    read,
    json: async () => {
      await read("json");
    },
    plaintext: async () => {
      await read("plaintext");
    },
  };
}

/**
 * The Lesto contender: `lesto-bare`, the routing/context pipeline with the secure
 * stack OFF (`secure: false`).
 *
 * We deliberately do NOT include a default (secure-on) Lesto here. In-process,
 * `app.handle()` has no request context, so every call keys to the SAME rate-limit
 * bucket; after ~100 calls the bucket drains and every later call returns 429 —
 * so a secure-on in-process row would measure the rejection path, not request
 * handling (a meaningless number). The cost of the default secure stack (a
 * per-request rate-limit store op) is real, but only the real-server suite — where
 * each connection is a distinct client — can measure it fairly.
 */
async function lestoContenders(): Promise<DispatchContender[]> {
  const { buildBenchApp } = await import("../apps/lesto/server.ts");
  const { app: bare } = await buildBenchApp({ secure: false });

  return [
    samplesFrom("lesto-bare", async (workload) => {
      const res = await bare.handle("GET", workload === "json" ? "/json" : "/plaintext");

      return typeof res.body === "string" ? res.body : String(res.body);
    }),
  ];
}

/** The Hono contender, or null if `hono` is not installed. */
async function honoContender(): Promise<DispatchContender | null> {
  let Hono: (new () => HonoApp) | undefined;
  try {
    ({ Hono } = (await import("hono")) as { Hono: new () => HonoApp });
  } catch {
    return null;
  }

  const app = new Hono();
  app.get("/json", (c) => c.json(jsonObject));
  app.get("/plaintext", (c) => c.text(plaintextBody));
  const reqs = { json: req("/json"), plaintext: req("/plaintext") };

  return samplesFrom("hono", async (workload) => (await app.fetch(reqs[workload])).text());
}

/** The Elysia contender, or null if `elysia` is not installed. */
async function elysiaContender(): Promise<DispatchContender | null> {
  let Elysia: (new () => ElysiaApp) | undefined;
  try {
    ({ Elysia } = (await import("elysia")) as { Elysia: new () => ElysiaApp });
  } catch {
    return null;
  }

  const app = new Elysia();
  app.get("/json", () => jsonObject);
  app.get("/plaintext", () => plaintextBody);
  const reqs = { json: req("/json"), plaintext: req("/plaintext") };

  return samplesFrom("elysia", async (workload) => (await app.handle(reqs[workload])).text());
}

/** The Fastify contender, or null if `fastify` is not installed. Uses light-my-request injection. */
async function fastifyContender(): Promise<DispatchContender | null> {
  let factory: (() => FastifyApp) | undefined;
  try {
    const mod = (await import("fastify")) as { default: () => FastifyApp };
    factory = mod.default;
  } catch {
    return null;
  }

  const app = factory();
  app.get("/json", (_req, reply) => reply.send(jsonObject));
  app.get("/plaintext", (_req, reply) => reply.type("text/plain").send(plaintextBody));
  await app.ready();

  return samplesFrom("fastify", async (workload) => {
    const res = await app.inject({
      method: "GET",
      url: workload === "json" ? "/json" : "/plaintext",
    });

    return res.body;
  });
}

/**
 * Build every dispatch contender that is installed. Lesto is always first; the
 * others are appended when present. Each app is built once; the short-lived bench
 * process reclaims everything on exit.
 */
export async function buildDispatchContenders(): Promise<DispatchContender[]> {
  const contenders: DispatchContender[] = [...(await lestoContenders())];
  for (const maybe of [await honoContender(), await elysiaContender(), await fastifyContender()]) {
    if (maybe) {
      contenders.push(maybe);
    }
  }

  return contenders;
}

/** The exact bytes each contender's `read` must return — the parity oracle. */
export const DISPATCH_ORACLE: Record<DispatchWorkload, string> = {
  json: jsonBody,
  plaintext: plaintextBody,
};

// Minimal structural types for the slices of each framework's surface we touch.
interface HonoApp {
  get(path: string, handler: (c: HonoCtx) => Response): void;
  fetch(request: Request): Response | Promise<Response>;
}
interface HonoCtx {
  json(value: unknown): Response;
  text(value: string): Response;
}
interface ElysiaApp {
  get(path: string, handler: () => unknown): ElysiaApp;
  handle(request: Request): Promise<Response>;
}
interface FastifyApp {
  get(path: string, handler: (req: unknown, reply: FastifyReply) => unknown): void;
  ready(): Promise<void>;
  inject(opts: { method: string; url: string }): Promise<{ body: string }>;
}
interface FastifyReply {
  type(value: string): FastifyReply;
  send(value: unknown): unknown;
}
