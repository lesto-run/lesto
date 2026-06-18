/**
 * The three real workloads, each expressed as a {@link SampleSource} the runner
 * can time. This is the thin glue between the pure runner and the live
 * subsystems — `@lesto/queue`, the SSR renderer, an HTTP handler. Each factory
 * builds its fixture once and returns a `() => Promise<void>` that does exactly
 * one unit of work, so the runner owns all timing and the workload owns none.
 *
 * Kept deliberately small and dependency-injected at the edges (the HTTP handler
 * and the SSR renderer are parameters) so the whole module is exercised by fast
 * in-process tests — no real socket, no spawned process — yet the production
 * `bench` run drives the genuine code paths.
 */

import { createElement } from "react";

import { installSchema, Queue } from "@lesto/queue";
import { openSqlite } from "@lesto/runtime";
import { Registry } from "@lesto/ui";
import { renderPage, renderPageMarkup } from "@lesto/ui/server";

import type { SqlDatabase } from "@lesto/queue";
import type { ComponentDef } from "@lesto/ui";
import type { SampleSource } from "./runner";

/**
 * An HTTP handler under test: `Request → Response`. The harness measures how fast
 * Lesto can turn a request into a response, with a bare echo handler as the
 * apples-to-apples baseline to compare against. Injected, not imported, so the
 * benchmark times a handler IN-PROCESS — the load loop's own overhead is held
 * constant and only the handler varies.
 */
export type HttpHandler = (request: Request) => Response | Promise<Response>;

/**
 * A `SampleSource` that issues one request through `handler` and drains the
 * response body, so the measured unit is the FULL request→response→read cycle a
 * real client pays — not just the time to return a half-built `Response`. The URL
 * is fixed; vary the handler to vary what is measured.
 */
export function httpWorkload(handler: HttpHandler, url = "http://bench.local/"): SampleSource {
  return async () => {
    const response = await handler(new Request(url));
    // Drain the body: an unread stream lets the handler defer real work past the
    // point we stopped the clock. Reading to completion makes the sample honest.
    await response.text();
  };
}

/**
 * The bare-runtime HTTP baseline — the comparison point every Lesto req/s number
 * is read against. It does the least a handler can: echo a fixed body. A Lesto
 * handler measured beside this one shows the framework's own overhead, not the
 * machine's raw ceiling.
 */
export const baselineHttpHandler: HttpHandler = () => new Response("ok");

/** A live queue plus the SQLite handle backing it, and a `close` to release the connection. */
export interface QueueFixture {
  readonly source: SampleSource;
  readonly close: () => void;
}

/**
 * Build a queue workload: a real `@lesto/queue` on an in-memory SQLite database,
 * pre-seeded so every measured unit has a job to claim. The sample is one
 * `claim()` — the hot path N concurrent workers contend on — so the run reports
 * genuine claims/sec under the queue's real atomic-claim SQL, not a mock.
 *
 * `jobs` rows are enqueued up front; size it to at least `iterations` so the
 * queue never drains mid-run (a `null` claim would still be timed, but it
 * measures an empty queue, not throughput). The returned `close` releases the
 * connection — the caller MUST call it.
 */
export async function createQueueWorkload(jobs: number): Promise<QueueFixture> {
  const { db, close } = await openSqlite();
  await installSchema(db as SqlDatabase);

  const queue = new Queue({ db: db as SqlDatabase });
  for (let i = 0; i < jobs; i += 1) {
    await queue.enqueue("bench_noop", { i });
  }

  const source: SampleSource = async () => {
    await queue.claim();
  };

  return { source, close };
}

/**
 * Build the SSR workload: a real `@lesto/ui` registry rendering a small but
 * non-trivial component tree to an HTML string on every sample, via the genuine
 * `renderPage` → `renderPageMarkup` path the web server uses. The fixture (the
 * registry and the tree) is built once; the measured unit is the render.
 */
export function createSsrWorkload(): SampleSource {
  const Box: ComponentDef = {
    name: "Box",
    props: {},
    children: true,
    render: (_props, children) => createElement("div", { className: "box" }, children),
  };

  const Text: ComponentDef = {
    name: "Text",
    props: { value: { type: "string", required: true } },
    children: false,
    render: (props) => createElement("span", null, props.value as string),
  };

  const registry = new Registry().define(Box).define(Text);

  // A representative nested tree: a container wrapping a handful of leaves — deep
  // enough that the render walks structure, small enough that the number reflects
  // the render path rather than one pathological mega-tree.
  const tree = {
    type: "Box",
    children: [
      { type: "Text", props: { value: "alpha" } },
      { type: "Text", props: { value: "beta" } },
      {
        type: "Box",
        children: [
          { type: "Text", props: { value: "gamma" } },
          { type: "Text", props: { value: "delta" } },
        ],
      },
    ],
  };

  return async () => {
    const page = renderPage(registry, tree);
    renderPageMarkup(page);
  };
}
