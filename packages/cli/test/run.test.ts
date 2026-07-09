import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientDefineMap, envField, PUBLIC_ENV_DEFINE_KEY } from "@lesto/env";
import { AssetsError, verifyPublicEnvDefine } from "@lesto/assets";

import { createDb, createTableSql, defineTable, dropTableSql, integer, text } from "@lesto/db";
import { currentContext, currentRequestSpan, lesto, runWithContext } from "@lesto/web";
import type { App, LestoAppConfig, KernelDatabase } from "@lesto/kernel";
import type { MigrationEntry } from "@lesto/migrate";
import type { RuntimeEntry } from "@lesto/content-core";
import type { Server, ServeOptions } from "@lesto/runtime";
import { parseTraceparent } from "@lesto/observability";
import type { TraceSeams } from "@lesto/observability";

import type { OutputSink, Site } from "@lesto/sites";
import type { ReleaseStore } from "@lesto/deploy";

import {
  CliError,
  declaresIslandDevPeer,
  LestoError,
  parsePort,
  parseServeLimit,
  parseStringFlag,
  run,
} from "../src/index";
// `isMissingSelfModule` / `missingModuleSpecifier` are the shared import-error classifier
// the bin's loaders route through — pure helpers exported from the core (`run.ts`), imported
// here directly (they are internal to the CLI's own wiring, not part of the package's public
// barrel like `declaresIslandDevPeer`/`run`).
import { isMissingSelfModule, missingModuleSpecifier } from "../src/run";
import type { ServeTracing } from "../src/run";
import type { BuildHook, BuildHookContext, CliDeps, DevError, ReleaseTarget } from "../src/index";
import { createDevState } from "../src/dev-state";
import type { AiTurn } from "../src/ai-bridge";
import { startMcpHttpServer } from "@lesto/mcp";
import type { LestoMcpContext, McpAuditRecord } from "@lesto/mcp";

// --- A real-enough app, built over an in-memory better-sqlite3 adapter. ---

const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

const migrations: MigrationEntry[] = [
  {
    version: "001_create_posts",
    migration: {
      up: (schema) => {
        schema.execute(createTableSql(posts, schema.dialect));
      },

      down: (schema) => {
        schema.execute(dropTableSql(posts));
      },
    },
  },
];

// Adapt better-sqlite3 (variadic params) to the kernel's array-positional
// surface. The terminals are async (ADR 0006): the synchronous better-sqlite3
// engine is wrapped so each terminal resolves a Promise (zero latency);
// prepare() stays sync. `transaction()` brackets BEGIN/COMMIT (ROLLBACK on
// reject) over the one connection.
function adapt(raw: Database.Database): KernelDatabase {
  const adapted: KernelDatabase = {
    exec: async (sql) => {
      raw.exec(sql);
    },

    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: async (params = []) => statement.run(...params),
        get: async (params = []) => statement.get(...params),
        all: async (params = []) => statement.all(...params),
      };
    },

    transaction: async (fn) => {
      raw.exec("BEGIN");

      try {
        const out = await fn(adapted);
        raw.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* preserve the original error */
        }

        throw error;
      }
    },
  };

  return adapted;
}

let database: Database.Database;

// The default app every command test runs against: a code-first `lesto()` app
// (LestoAppConfig). `GET /posts` answers 200 with `{ posts: [] }` and anything
// unmatched 404s — so the build/deploy/dev tests render over a real app.
function buildConfig(): LestoAppConfig {
  const app = lesto()
    .get("/posts", (c) => c.json({ posts: [] }))
    .post("/posts", (c) => c.json({ created: true }, 201))
    .get("/posts/:id", (c) => c.json({ id: c.param("id") }));

  return {
    db: adapt(database),
    app,
    migrations,
  };
}

// A capturing `out` and a fresh deps bag per test.
let lines: string[];

function depsWith(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    loadApp: () => Promise.resolve(buildConfig()),
    serve: vi.fn(),
    buildContent: () => Promise.resolve([]),
    persistEntries: (_db, entries) => Promise.resolve({ persisted: entries.length }),
    pruneEntries: (_db, _entries) => Promise.resolve({ deleted: 0 }),
    deleteEntry: vi.fn(() => Promise.resolve({ deleted: 1 })),
    createEntry: vi.fn(() => Promise.resolve()),
    loadSites: () => Promise.resolve([]),
    sink: () => () => Promise.resolve(),
    uploader: () => ({
      read: () => Promise.resolve(new Uint8Array()),
      put: () => Promise.resolve(),
    }),
    releaseStore: () => memoryReleaseStore().store,
    now: () => 0,
    cloudflare: { deploy: () => Promise.resolve({ url: undefined }), rollback: vi.fn() },
    checkHealth: () => Promise.resolve(true),
    out: (line) => lines.push(line),
    ...overrides,
  };
}

// An in-memory ReleaseStore: keys land in a map, the pointer in a box — so the
// release tests assert the staged prefix and the flip without a filesystem.
function memoryReleaseStore(): {
  store: ReleaseStore;
  shipped: Map<string, string>;
  pointer: { current?: string };
} {
  const shipped = new Map<string, string>();
  const pointer: { current?: string } = {};

  const store: ReleaseStore = {
    read: (_outRoot, file) => Promise.resolve(new TextEncoder().encode(`bytes:${file}`)),
    put: (key, contents: Uint8Array | string) => {
      shipped.set(
        key,
        typeof contents === "string" ? contents : new TextDecoder().decode(contents),
      );

      return Promise.resolve();
    },
    setCurrent: (version) => {
      pointer.current = version;

      return Promise.resolve();
    },
    getCurrent: () => Promise.resolve(pointer.current),
    listReleases: () =>
      Promise.resolve([...new Set([...shipped.keys()].map((key) => key.split("/")[1] as string))]),
  };

  return { store, shipped, pointer };
}

// A minimal-but-valid runtime entry, with the metadata content-core attaches.
function entry(collection: string, id: string, data: Record<string, unknown>): RuntimeEntry {
  return {
    id,
    collection,
    file: {
      path: `${collection}/${id}.md`,
      fileName: `${id}.md`,
      extension: ".md",
      directory: collection,
      pathSegments: [id],
      isIndex: false,
    },
    slug: id,
    ...data,
  };
}

beforeEach(() => {
  database = new Database(":memory:");
  lines = [];
});

afterEach(() => {
  database.close();
});

describe("run routes", () => {
  it("prints every route from the lesto() app as method\\tpattern and returns 0", async () => {
    const code = await run(["routes"], depsWith());

    expect(code).toBe(0);

    // The code-first shape: method + pattern, no controller#action target.
    expect(lines).toEqual(["GET\t/posts", "POST\t/posts", "GET\t/posts/:id"]);
  });
});

describe("run migrate", () => {
  it("boots the app and prints the applied migration versions", async () => {
    const code = await run(["migrate"], depsWith());

    expect(code).toBe(0);
    expect(lines).toEqual(["applied 001_create_posts"]);
  });
});

// A spy serve that yields a Server stub bound to the port we ask for, so we can
// assert both that serve saw the parsed port and that its bound port is printed.
const fakeServe = (boundPort: number) =>
  vi.fn(
    (_app: App, _options?: ServeOptions): Promise<Server> =>
      Promise.resolve({ port: boundPort, close: () => Promise.resolve() }),
  );

// A `ServeTracing` whose only OBSERVABLE is `stopInterval` — the flush-cadence handle
// the long-lived teardown paths (a `serve`/`dev` graceful shutdown AND the dev-MCP-reject
// unwind) call. Injected through the `CliDeps.buildServeTracing` seam so a test can spy
// that call, which a real `unref`'d interval otherwise makes unobservable. `serveOptions`
// and `seams` are inert here: `deps.serve` is faked (so the tracer/drain are never
// exercised) and the harness `loadApp` ignores the seams it is handed — so injecting this
// changes nothing but making the lifecycle assertable.
function fakeServeTracing(): {
  buildServeTracing: NonNullable<CliDeps["buildServeTracing"]>;
  stopInterval: ReturnType<typeof vi.fn>;
} {
  const stopInterval = vi.fn();

  const tracing: ServeTracing = {
    serveOptions: {
      // Never invoked — the faked `serve` mints no request span.
      tracer: (() => undefined) as unknown as ServeTracing["serveOptions"]["tracer"],
      parseTraceparent,
      onDrain: () => Promise.resolve(),
    },
    // Never invoked — the harness `loadApp` ignores its seams arg.
    seams: {} as TraceSeams,
    stopInterval,
  };

  return { buildServeTracing: () => tracing, stopInterval };
}

/** Pull the readiness probe out of the health option the serve command wired. */
function readinessProbe(serve: ReturnType<typeof fakeServe>): () => Promise<boolean> {
  const [, options] = serve.mock.calls[0]!;
  const health = options?.health;

  if (!health) throw new Error("serve was called without a health option");

  if (!health.isReady) throw new Error("health option carried no isReady probe");

  return health.isReady as () => Promise<boolean>;
}

// A serve fake that drives the request the way the real runtime does for tracing:
// mint the request span through the wired tracer, publish it on the context while
// the app handles the request (so an inline seam parents on it), then end it. The
// captured app + tracer let a test fire a request and read the resulting spans.
function tracingServe(): {
  serve: CliDeps["serve"];
  request: (method: string, path: string) => Promise<void>;
} {
  let captured: { app: App; options: ServeOptions | undefined } | undefined;

  const serve = vi.fn((app: App, options?: ServeOptions): Promise<Server> => {
    captured = { app, options };

    // Mirror the real runtime: `close` runs the wired `onDrain` (the final flush)
    // before resolving, so a drain through the shutdown hook ships the buffered
    // spans exactly as production does.
    return Promise.resolve({
      port: 3000,
      close: () => options?.onDrain?.() ?? Promise.resolve(),
    });
  });

  const request = async (method: string, path: string): Promise<void> => {
    if (captured === undefined) throw new Error("serve was never called");

    const { app, options } = captured;
    const tracer = options?.tracer;

    // Tracing off: just run the handler, no span context (mirrors the runtime
    // when no tracer is wired).
    if (tracer === undefined) {
      await app.handle(method, path);

      return;
    }

    // Tracing on: mint the request span, publish it on the context for the
    // duration of the handler (so `currentRequestSpan` reads it and the query's
    // `onQuery` seam parents on it), then end it.
    const span = tracer.startSpan("http.request");

    await runWithContext({ requestId: "req-1", span }, () => app.handle(method, path));

    span.end();
  };

  return { serve: serve as unknown as CliDeps["serve"], request };
}

describe("run serve / dev", () => {
  it("serves on the --port flag and prints the listening URL", async () => {
    const serve = fakeServe(8080);

    const config = buildConfig();
    const loadApp = () => Promise.resolve(config);

    const code = await run(["serve", "--port", "8080"], depsWith({ serve, loadApp }));

    expect(code).toBe(0);
    expect(serve).toHaveBeenCalledTimes(1);

    // Called with the booted app and the parsed port.
    const [app, options] = serve.mock.calls[0]!;
    expect(app.migrationsApplied).toEqual(["001_create_posts"]);
    expect(options?.port).toBe(8080);

    expect(lines).toEqual(["listening on http://127.0.0.1:8080"]);
  });

  it("falls back to the default port when no flag is given", async () => {
    const serve = fakeServe(3000);

    const code = await run(["serve"], depsWith({ serve }));

    expect(code).toBe(0);

    const [, options] = serve.mock.calls[0]!;
    expect(options?.port).toBe(3000);

    expect(lines).toEqual(["listening on http://127.0.0.1:3000"]);
  });

  it("wires no tracer on serve when LESTO_OTLP_URL is unset", async () => {
    const serve = fakeServe(3000);

    await run(["serve"], depsWith({ serve, env: {} }));

    const [, options] = serve.mock.calls[0]!;

    expect(options?.tracer).toBeUndefined();
    expect(options?.onDrain).toBeUndefined();
  });

  it("wires the OTLP tracer on serve when LESTO_OTLP_URL is set", async () => {
    const close = vi.fn(() => Promise.resolve());
    const serve = vi.fn(
      (_app: App, _options?: ServeOptions): Promise<Server> =>
        Promise.resolve({ port: 3000, close }),
    );
    const installShutdown = vi.fn();

    await run(
      ["serve"],
      depsWith({
        serve,
        installShutdown,
        env: { LESTO_OTLP_URL: "http://collector:4318/v1/traces" },
      }),
    );

    const [, options] = serve.mock.calls[0]!;

    expect(options?.tracer).toBeDefined();
    expect(typeof options?.onDrain).toBe("function");

    // The shutdown hook drains cleanly (the `stopInterval` half is asserted by the
    // seam-injecting test below, which can observe the flush-cadence handle).
    const drain = installShutdown.mock.calls[0]![0] as () => Promise<void>;
    await expect(drain()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stops the flush cadence on serve shutdown, observed through the tracing seam (L-fe2da7f5)", async () => {
    const close = vi.fn(() => Promise.resolve());
    const serve = vi.fn(
      (_app: App, _options?: ServeOptions): Promise<Server> =>
        Promise.resolve({ port: 3000, close }),
    );
    const installShutdown = vi.fn();
    const { buildServeTracing, stopInterval } = fakeServeTracing();

    await run(["serve"], depsWith({ serve, installShutdown, buildServeTracing }));

    // The interval runs until shutdown — booting alone must NOT stop the cadence.
    expect(stopInterval).not.toHaveBeenCalled();

    // The shutdown hook drains the server, THEN stops the flush cadence.
    const drain = installShutdown.mock.calls[0]![0] as () => Promise<void>;
    await drain();

    expect(close).toHaveBeenCalledTimes(1);
    expect(stopInterval).toHaveBeenCalledTimes(1);
    // Order is load-bearing (run.ts): the final drain flush must run before the
    // cadence stops, or it is cut short. Assert it, not just the call counts.
    expect(close.mock.invocationCallOrder[0]!).toBeLessThan(
      stopInterval.mock.invocationCallOrder[0]!,
    );
  });

  it("wires /readyz to a real database ping that answers true when the DB is up", async () => {
    const serve = fakeServe(3000);

    await run(["serve"], depsWith({ serve }));

    // The probe runs SELECT 1 against the live in-memory database → ready.
    expect(await readinessProbe(serve)()).toBe(true);
  });

  it("reports not-ready when the database ping throws (a down/failing DB)", async () => {
    const serve = fakeServe(3000);

    // A lesto() app over a database whose query rejects — and no migrations, so
    // boot never touches it; only the readiness probe does.
    const downConfig: LestoAppConfig = {
      db: {
        exec: () => Promise.resolve(),
        prepare: () => ({
          run: () => Promise.reject(new Error("db down")),
          get: () => Promise.reject(new Error("db down")),
          all: () => Promise.reject(new Error("db down")),
        }),
        transaction: (fn) => fn(downConfig.db),
      },
      app: lesto().get("/", (c) => c.text("ok")),
    };

    await run(["serve"], depsWith({ serve, loadApp: () => Promise.resolve(downConfig) }));

    expect(await readinessProbe(serve)()).toBe(false);
  });

  it("registers a graceful-shutdown hook that drains the server", async () => {
    const close = vi.fn(() => Promise.resolve());
    const serve = vi.fn(
      (_app: App, _options?: ServeOptions): Promise<Server> =>
        Promise.resolve({ port: 3000, close }),
    );
    const installShutdown = vi.fn();

    const code = await run(["serve"], depsWith({ serve, installShutdown }));

    expect(code).toBe(0);
    expect(installShutdown).toHaveBeenCalledTimes(1);

    // The registered hook drains by closing the server.
    const drain = installShutdown.mock.calls[0]![0] as () => Promise<void>;
    await drain();
    expect(close).toHaveBeenCalledTimes(1);
  });

  // --- Task 1: DB query child-spans on the SERVED path ---
  //
  // A project whose `lesto.app.ts` default-exports a config FACTORY threads the
  // tracer's `db.onQuery` seam into its own `createDb(handle, { onQuery })`. These
  // pin that `runServe` hands the seams to `loadApp` when tracing is on (so a query
  // run during a request becomes a `db.query` CHILD span of the request span), and
  // hands NOTHING when tracing is off (so the app runs untraced — zero overhead).

  // A `loadApp` factory mirroring the production path: it receives the trace seams
  // and wires them into `createDb(handle, { onQuery })`, so a `/posts` request runs
  // a query whose span must parent on the request span. It records which seams it
  // was called with, so a test can assert the off-path passes none.
  function tracingLoadApp(): {
    loadApp: (seams?: TraceSeams) => Promise<LestoAppConfig>;
    seamsSeen: Array<TraceSeams | undefined>;
  } {
    const seamsSeen: Array<TraceSeams | undefined> = [];

    const loadApp = (seams?: TraceSeams) => {
      seamsSeen.push(seams);

      const handle = adapt(database);
      // The seam-wired db — the SAME shape estate's `buildIdentity` builds.
      const db = createDb(handle, seams === undefined ? {} : { onQuery: seams.onQuery });

      const app = lesto()
        .get("/posts", async (c) => {
          const rows = await db.raw<{ id: number; title: string }>("SELECT id, title FROM posts");

          return c.json({ posts: rows });
        })
        .get("/ping", (c) => c.json({ ok: true }));

      return Promise.resolve<LestoAppConfig>({ db: handle, app, migrations });
    };

    return { loadApp, seamsSeen };
  }

  it("emits a db.query CHILD span of the request span on the served path when tracing is on", async () => {
    // Capture the OTLP export the drain flush POSTs, so the span tree can be read
    // back exactly as a collector would receive it.
    const bodies: string[] = [];
    const fetchFn = ((_url: string, init?: { body?: string }) => {
      if (init?.body !== undefined) bodies.push(init.body);

      return Promise.resolve({ ok: true, status: 200 } as Response);
    }) as unknown as typeof fetch;

    vi.stubGlobal("fetch", fetchFn);

    try {
      const { loadApp, seamsSeen } = tracingLoadApp();
      const { serve, request } = tracingServe();
      const installShutdown = vi.fn();

      await run(
        ["serve"],
        depsWith({
          serve,
          loadApp,
          installShutdown,
          env: { LESTO_OTLP_URL: "http://collector:4318/v1/traces", LESTO_OTLP_SERVICE: "served" },
        }),
      );

      // `runServe` handed the live seams to the app factory (not undefined).
      expect(seamsSeen).toHaveLength(1);
      expect(seamsSeen[0]).toBeDefined();

      // Fire the request that runs a query, then drain (the drain flush ships the
      // buffered spans through the stubbed fetch).
      await request("GET", "/posts");

      const drain = installShutdown.mock.calls[0]![0] as () => Promise<void>;
      await drain();

      // Parse the exported spans out of the OTLP body the exporter POSTed.
      expect(bodies).toHaveLength(1);

      const payload = JSON.parse(bodies[0]!) as {
        resourceSpans: {
          scopeSpans: { spans: { name: string; spanId: string; parentSpanId?: string }[] }[];
        }[];
      };
      const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;

      const requestSpan = spans.find((s) => s.name === "http.request");
      const querySpan = spans.find((s) => s.name === "db.query");

      expect(requestSpan).toBeDefined();
      expect(querySpan).toBeDefined();

      // THE ACCEPTANCE: the query span is a CHILD of the request span — the deep
      // request→query tree on the served path, not just the integration harness.
      expect(querySpan?.parentSpanId).toBe(requestSpan?.spanId);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes no seams to loadApp and emits no db.query span when tracing is off", async () => {
    const { loadApp, seamsSeen } = tracingLoadApp();
    const { serve, request } = tracingServe();

    await run(["serve"], depsWith({ serve, loadApp, env: {} }));

    // The factory was called with NO seams — the app is untraced, zero overhead.
    expect(seamsSeen).toEqual([undefined]);

    // The request still runs its query; with no seam wired it emits no span. No
    // tracer means no `onDrain` flush either — there is simply nothing to export.
    await request("GET", "/posts");

    const [, options] = (serve as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((options as ServeOptions | undefined)?.tracer).toBeUndefined();
  });
});

// A reader that answers the client bundle with bytes, everything else absent.
// The dev dispatcher passes a root-relative path, so the key has no leading slash.
const clientBundleReader = (file: string): Promise<string | undefined> =>
  Promise.resolve(file === "client.js" ? "/* island bundle */" : undefined);

describe("run dev", () => {
  const sites: readonly Site[] = [
    { name: "marketing", render: "static", basePath: "/", pages: ["/"] },
    { name: "mls", render: "dynamic", basePath: "/mls" },
  ];

  it("serves every zone live on one origin and prints the dev URL", async () => {
    const serve = fakeServe(5173);

    const code = await run(
      ["dev", "--port", "5173"],
      depsWith({ serve, loadSites: () => Promise.resolve(sites) }),
    );

    expect(code).toBe(0);
    expect(serve).toHaveBeenCalledTimes(1);

    // The server fronts the dev dispatcher (a handle), not a bare app.
    const [app, options] = serve.mock.calls[0]!;
    expect(typeof app.handle).toBe("function");
    expect(options?.port).toBe(5173);
    expect(lines).toEqual(["dev server on http://127.0.0.1:5173"]);
  });

  it("registers a graceful-shutdown hook for the dev server too", async () => {
    const close = vi.fn(() => Promise.resolve());
    const serve = vi.fn(
      (_app: App, _options?: ServeOptions): Promise<Server> =>
        Promise.resolve({ port: 5173, close }),
    );
    const installShutdown = vi.fn();

    await run(
      ["dev"],
      depsWith({ serve, installShutdown, loadSites: () => Promise.resolve(sites) }),
    );

    expect(installShutdown).toHaveBeenCalledTimes(1);

    const drain = installShutdown.mock.calls[0]![0] as () => Promise<void>;
    await drain();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("wires no tracer on dev when LESTO_OTLP_URL is unset (tracing off by default)", async () => {
    const serve = fakeServe(5173);

    await run(["dev"], depsWith({ serve, env: {}, loadSites: () => Promise.resolve(sites) }));

    const [, options] = serve.mock.calls[0]!;

    expect(options?.tracer).toBeUndefined();
    expect(options?.onDrain).toBeUndefined();
  });

  it("wires the OTLP tracer on dev when LESTO_OTLP_URL is set, flushing on drain", async () => {
    const calls: string[] = [];

    const fetchFn = ((url: string) => {
      calls.push(url);

      return Promise.resolve({ ok: true, status: 200 } as Response);
    }) as unknown as typeof fetch;

    vi.stubGlobal("fetch", fetchFn);

    try {
      // A serve fake that mirrors the real runtime's `close`: it runs the wired
      // `onDrain` hook (the final flush) before resolving — so the drain test
      // exercises the same flush path production runs.
      let capturedOnDrain: (() => Promise<void>) | undefined;

      const close = vi.fn(async () => {
        await capturedOnDrain?.();
      });

      const serve = vi.fn((_app: App, options?: ServeOptions): Promise<Server> => {
        capturedOnDrain = options?.onDrain;

        return Promise.resolve({ port: 5173, close });
      });

      const installShutdown = vi.fn();

      await run(
        ["dev"],
        depsWith({
          serve,
          installShutdown,
          env: { LESTO_OTLP_URL: "http://collector:4318/v1/traces", LESTO_OTLP_SERVICE: "estate" },
          loadSites: () => Promise.resolve(sites),
        }),
      );

      const [, options] = serve.mock.calls[0]!;

      // The full serve-options slice rode in: a request tracer, the traceparent
      // parser, and a drain flush.
      expect(options?.tracer).toBeDefined();
      expect(typeof options?.parseTraceparent).toBe("function");
      expect(typeof options?.onDrain).toBe("function");

      // Mint a span and publish it on a request context, so the shared
      // `currentRequestSpan` seam (the tracer's `currentSpan`) reads it back —
      // then end it so the drain flush has a batch to ship.
      const span = options!.tracer!.startSpan("http.request");

      runWithContext({ requestId: "r-1", span }, () => {
        expect(currentContext()?.span).toBe(span);
        expect(currentRequestSpan()).toBe(span);
      });

      span.end();

      // The shutdown hook drains the server (whose close runs onDrain → flush),
      // then stops the interval.
      const drain = installShutdown.mock.calls[0]![0] as () => Promise<void>;
      await drain();

      expect(close).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(["http://collector:4318/v1/traces"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("serves the client bundle through readAsset when one is provided", async () => {
    const serve = fakeServe(3000);

    await run(
      ["dev"],
      depsWith({ serve, readAsset: clientBundleReader, loadSites: () => Promise.resolve(sites) }),
    );

    const [app] = serve.mock.calls[0]!;

    // The dev dispatcher the server received serves the asset live.
    const asset = await app.handle("GET", "/client.js");
    expect(asset.status).toBe(200);
    expect(asset.body).toBe("/* island bundle */");

    // ...and a non-asset path renders live through the app: the 404 body is the
    // app's own "Not Found" (this config has no "/" route), proving the dev
    // dispatcher delegated to the live handler rather than reading a static file.
    const page = await app.handle("GET", "/");
    expect(page.status).toBe(404);
    expect(page.body).toBe("Not Found");
  });
});

// A capturing sink built per outDir, so a test can assert both the directory it
// was rooted at and exactly which pages were written through it.
function recordingSink(): {
  sink: (outDir: string) => OutputSink;
  outDirs: string[];
  written: Map<string, string>;
} {
  const outDirs: string[] = [];
  const written = new Map<string, string>();

  const sink = (outDir: string): OutputSink => {
    outDirs.push(outDir);

    return (path: string, contents: Uint8Array | string) => {
      written.set(
        path,
        typeof contents === "string" ? contents : new TextDecoder().decode(contents),
      );

      return Promise.resolve();
    };
  };

  return { sink, outDirs, written };
}

// The fixture app answers `GET /posts` with 200 (resources("posts")#index) and
// anything unmatched with 404 — so these build over real renders, not fakes.
function staticSite(name: string, pages: readonly string[]): Site {
  return { name, render: "static", basePath: "/", pages };
}

describe("run build", () => {
  it("prerenders the project's static sites to disk and reports each", async () => {
    const { sink, outDirs, written } = recordingSink();

    const code = await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink,
      }),
    );

    expect(code).toBe(0);

    // Default output root, and the page written through the sink for it.
    expect(outDirs).toEqual(["out"]);
    expect(written.get("marketing/posts/index.html")).toContain('"posts"');

    expect(lines).toEqual(["built marketing: 1 page"]);
  });

  it("says 'pages' (plural) and honors --out", async () => {
    const { sink, outDirs } = recordingSink();

    const code = await run(
      ["build", "--out", "dist"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts", "/posts"])]),
        sink,
      }),
    );

    expect(code).toBe(0);
    expect(outDirs).toEqual(["dist"]);
    expect(lines).toEqual(["built marketing: 2 pages"]);
  });

  it("with --target, builds only the named site", async () => {
    const { sink } = recordingSink();

    const code = await run(
      ["build", "--target", "marketing"],
      depsWith({
        loadSites: () =>
          Promise.resolve([staticSite("marketing", ["/posts"]), staticSite("docs", ["/posts"])]),
        sink,
      }),
    );

    expect(code).toBe(0);
    expect(lines).toEqual(["built marketing: 1 page"]);
  });

  it("throws CLI_UNKNOWN_TARGET for a target that names no site", async () => {
    try {
      await run(
        ["build", "--target", "ghost"],
        depsWith({ loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]) }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("CLI_UNKNOWN_TARGET");
      expect((error as CliError).details).toEqual({ target: "ghost", known: ["marketing"] });
    }
  });

  it("fails the build (SITES_PAGE_FAILED) on a non-2xx page", async () => {
    const { sink, written } = recordingSink();

    await expect(
      run(
        ["build"],
        depsWith({
          // `/missing` is unmatched → 404; the build must refuse it.
          loadSites: () => Promise.resolve([staticSite("marketing", ["/posts", "/missing"])]),
          sink,
        }),
      ),
    ).rejects.toMatchObject({ code: "SITES_PAGE_FAILED" });

    // Nothing was written — the build failed before committing a page.
    expect(written.size).toBe(0);
    expect(lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The build folds in the output clean and a post-build hook (`lesto.build.ts`),
// so a static site no longer forks `lesto build` with a hand-rolled script.
// ---------------------------------------------------------------------------

describe("run build — clean + post-build hook", () => {
  it("cleans each static site's own output dir, not the whole root (so --target spares siblings)", async () => {
    const cleaned: string[] = [];

    await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink: recordingSink().sink,
        cleanDir: (dir) => {
          cleaned.push(dir);

          return Promise.resolve();
        },
      }),
    );

    // The site dir, not "out" — a sibling site's output is never wiped.
    expect(cleaned).toEqual(["out/marketing"]);
  });

  it("cleans the chosen --out dir's site subtree", async () => {
    const cleaned: string[] = [];

    await run(
      ["build", "--out", "dist"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink: recordingSink().sink,
        cleanDir: (dir) => {
          cleaned.push(dir);

          return Promise.resolve();
        },
      }),
    );

    expect(cleaned).toEqual(["dist/marketing"]);
  });

  it("cleans nothing when no static site is selected (a dynamic-only build)", async () => {
    const cleaned: string[] = [];

    await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([{ name: "api", render: "dynamic", basePath: "/api" }]),
        sink: recordingSink().sink,
        cleanDir: (dir) => {
          cleaned.push(dir);

          return Promise.resolve();
        },
      }),
    );

    expect(cleaned).toEqual([]);
  });

  it("fires the post-build hook with each site's name, routes, and an output-rooted sink", async () => {
    const { sink, outDirs, written } = recordingSink();
    const seen: BuildHookContext[] = [];
    const onBuilt: BuildHook = (ctx) => {
      seen.push(ctx);

      // The hook writes through its site's sink, beside that site's prerendered HTML.
      return ctx.sites[0]?.sink("extra.txt", "hi");
    };

    const code = await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink,
        loadBuildHook: () => Promise.resolve(onBuilt),
      }),
    );

    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.outDir).toBe("out");
    expect(seen[0]?.sites).toEqual([
      { name: "marketing", routes: ["/posts"], sink: expect.any(Function) },
    ]);
    // The per-site sink is rooted at out/marketing, and the hook's write went through it.
    expect(outDirs).toContain("out/marketing");
    expect(written.get("extra.txt")).toBe("hi");
  });

  it("skips the hook when lesto.build.ts resolves no default export (undefined)", async () => {
    const code = await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink: recordingSink().sink,
        loadBuildHook: () => Promise.resolve(undefined),
      }),
    );

    expect(code).toBe(0);
    expect(lines).toEqual(["built marketing: 1 page"]);
  });
});

// ---------------------------------------------------------------------------
// ADR 0011 Seam 3: the CLI runs the @lesto/assets client build when the project
// has an `app/islands/` directory. The probe + builder + watcher are seams.
// ---------------------------------------------------------------------------

describe("run build — island client assets", () => {
  it("builds the client (production) into the out dir when app/islands/ exists", async () => {
    const built: Array<{ outDir: string; mode: string; dialect: string }> = [];

    const code = await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink: recordingSink().sink,
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets: (options) => {
          built.push(options);

          return Promise.resolve();
        },
      }),
    );

    expect(code).toBe(0);
    // The app config carries no `ui` key, so the client build defaults to "react".
    // A lone static site ("marketing") is served from out/marketing/, so its client
    // bundle builds there — beside the pages — not loose in out/.
    expect(built).toEqual([{ outDir: "out/marketing", mode: "production", dialect: "react" }]);
  });

  it("refuses a multi-static build that shares the island bundle (L-0d58f58c — would orphan the assets)", async () => {
    const built: Array<{ outDir: string }> = [];

    // Two static sites, each served from its OWN out/<name>/, but ONE shared island bundle:
    // building it loose in out/ would 404 from both sites at runtime. The build must refuse
    // loudly, BEFORE any asset is written, and point at the working `--target` per-site path.
    const error = await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("a", []), staticSite("b", [])]),
        sink: recordingSink().sink,
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets: (options) => {
          built.push(options);

          return Promise.resolve();
        },
      }),
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("CLI_MULTI_STATIC_ASSETS_UNSUPPORTED");
    expect((error as CliError).details["staticSites"]).toEqual(["a", "b"]);
    expect(built).toEqual([]); // it failed before building (or cleaning) anything
  });

  it("refuses a multi-static build that shares only a CSS bundle (no islands) too", async () => {
    // The same orphaning hazard reaches styles.css: two static sites, no islands, but a
    // shared CSS entry — the compiled styles would land loose in out/, unreachable from
    // either site's served tree. The guard fires on the styles half too.
    const error = await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("a", []), staticSite("b", [])]),
        sink: recordingSink().sink,
        cssEntryExists: () => Promise.resolve(true),
      }),
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("CLI_MULTI_STATIC_ASSETS_UNSUPPORTED");
    expect((error as CliError).details).toMatchObject({ hasClient: false, hasStyles: true });
  });

  it("still builds a multi-static project that has NO shared island/CSS assets", async () => {
    // No islands and no CSS entry → nothing to orphan, so the guard does NOT fire and the
    // prerender-only multi-static build proceeds unaffected.
    const code = await run(
      ["build"],
      depsWith({
        // Empty page sets (like the sibling multi-static tests) so the case exercises the
        // guard — which runs before prerender — without driving the real render pipeline.
        loadSites: () => Promise.resolve([staticSite("a", []), staticSite("b", [])]),
        sink: recordingSink().sink,
        hasIslandsDir: () => Promise.resolve(false),
        cssEntryExists: () => Promise.resolve(false),
      }),
    );

    expect(code).toBe(0);
  });

  it("builds client assets into the output root when no static site is selected", async () => {
    const built: Array<{ outDir: string }> = [];

    await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([{ name: "api", render: "dynamic", basePath: "/api" }]),
        sink: recordingSink().sink,
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets: (options) => {
          built.push(options);

          return Promise.resolve();
        },
      }),
    );

    expect(built.map((b) => b.outDir)).toEqual(["out"]);
  });

  it("skips the client build when app/islands/ does not exist (island-less app)", async () => {
    const buildClientAssets = vi.fn(() => Promise.resolve());

    await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink: recordingSink().sink,
        hasIslandsDir: () => Promise.resolve(false),
        buildClientAssets,
      }),
    );

    expect(buildClientAssets).not.toHaveBeenCalled();
  });

  it("does nothing when the asset seams are absent (the default, no client pipeline)", async () => {
    // No hasIslandsDir/buildClientAssets in deps → the build runs unchanged.
    const code = await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink: recordingSink().sink,
      }),
    );

    expect(code).toBe(0);
    expect(lines).toEqual(["built marketing: 1 page"]);
  });

  it("fails with CLI_CLIENT_BUILD_FAILED when the bundler throws", async () => {
    const cause = new Error("esbuild blew up");

    try {
      await run(
        ["build"],
        depsWith({
          loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
          sink: recordingSink().sink,
          hasIslandsDir: () => Promise.resolve(true),
          buildClientAssets: () => Promise.reject(cause),
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("CLI_CLIENT_BUILD_FAILED");
      expect((error as CliError).details).toMatchObject({
        outDir: "out/marketing",
        mode: "production",
        cause,
      });
    }
  });

  it("threads the resolved PUBLIC_* inject map into the client build", async () => {
    const built: Array<{ publicEnvDefine?: Record<string, string> }> = [];
    const define = clientDefineMap(
      { PUBLIC_API_BASE: envField.string() },
      { PUBLIC_API_BASE: "x" },
    );

    await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink: recordingSink().sink,
        hasIslandsDir: () => Promise.resolve(true),
        resolvePublicEnvDefine: () => Promise.resolve(define),
        buildClientAssets: (options) => {
          built.push(options);

          return Promise.resolve();
        },
      }),
    );

    expect(built).toHaveLength(1);
    expect(built[0]?.publicEnvDefine).toEqual(define);
  });

  it("passes no inject map when the env resolver yields undefined (app has no client env)", async () => {
    const built: Array<{ publicEnvDefine?: Record<string, string> }> = [];

    await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink: recordingSink().sink,
        hasIslandsDir: () => Promise.resolve(true),
        resolvePublicEnvDefine: () => Promise.resolve(undefined),
        buildClientAssets: (options) => {
          built.push(options);

          return Promise.resolve();
        },
      }),
    );

    expect(built[0]?.publicEnvDefine).toBeUndefined();
  });

  it("fails with CLI_CLIENT_BUILD_FAILED when resolving the PUBLIC_* env throws (bad var)", async () => {
    const cause = new Error("ENV_VALIDATION_FAILED: PUBLIC_API_BASE is required");

    try {
      await run(
        ["build"],
        depsWith({
          loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
          sink: recordingSink().sink,
          hasIslandsDir: () => Promise.resolve(true),
          // A missing/malformed required PUBLIC_* var throws while the map is
          // computed — it must fail the build coded, not silently at hydration.
          resolvePublicEnvDefine: () => Promise.reject(cause),
          buildClientAssets: () => Promise.resolve(),
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("CLI_CLIENT_BUILD_FAILED");
      expect((error as CliError).details).toMatchObject({ cause });
    }
  });

  it("the env-inject contract round-trips: clientDefineMap's key passes the bundler guard", () => {
    // The `__LESTO_PUBLIC_ENV__` contract is spelled in BOTH @lesto/env (the producer,
    // clientDefineMap) and @lesto/assets (the verifier, verifyPublicEnvDefine). This
    // pins them together: the map @lesto/env emits must survive the assets guard, so a
    // drift in either constant fails here rather than at a real `lesto build`.
    const map = clientDefineMap({ PUBLIC_API_BASE: envField.string() }, { PUBLIC_API_BASE: "x" });

    expect(Object.keys(map)).toEqual([PUBLIC_ENV_DEFINE_KEY]);
    expect(verifyPublicEnvDefine(map)).toEqual(map);
  });
});

describe("run build — Tailwind CSS (ADR 0037)", () => {
  it("builds the stylesheet (production) into the out dir when the CSS entry exists", async () => {
    const built: Array<{ entry: string; outDir: string; mode: string }> = [];

    const code = await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink: recordingSink().sink,
        cssEntryExists: () => Promise.resolve(true),
        buildAppStyles: (options) => {
          built.push(options);

          return Promise.resolve();
        },
      }),
    );

    expect(code).toBe(0);
    // No `ui.css`/`ui.cssScanRoot` keys → entry defaults to `app/styles/app.css` and
    // the scan root to `app`. A lone static site builds its styles into out/marketing/.
    expect(built).toEqual([
      { entry: "app/styles/app.css", outDir: "out/marketing", mode: "production", scanRoot: "app" },
    ]);
  });

  it("resolves the CSS entry from ui.css when set", async () => {
    const built: string[] = [];

    await run(
      ["build"],
      depsWith({
        loadApp: () =>
          Promise.resolve({
            ...buildConfig(),
            ui: { dialect: "react" as const, css: "app/theme.css" },
          }),
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink: recordingSink().sink,
        cssEntryExists: (path) => {
          built.push(path);

          return Promise.resolve(true);
        },
        buildAppStyles: (options) => {
          built.push(options.entry);

          return Promise.resolve();
        },
      }),
    );

    // Both the probe and the build see the configured entry, not the convention.
    expect(built).toEqual(["app/theme.css", "app/theme.css"]);
  });

  it("passes ui.cssScanRoot through to the build (an app whose markup is outside app/)", async () => {
    const scanRoots: string[] = [];

    await run(
      ["build"],
      depsWith({
        loadApp: () =>
          Promise.resolve({
            ...buildConfig(),
            ui: { dialect: "react" as const, cssScanRoot: "src" },
          }),
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink: recordingSink().sink,
        cssEntryExists: () => Promise.resolve(true),
        buildAppStyles: (options) => {
          scanRoots.push(options.scanRoot);

          return Promise.resolve();
        },
      }),
    );

    expect(scanRoots).toEqual(["src"]);
  });

  it("skips the CSS build when the entry does not exist (Tailwind opt-in)", async () => {
    const buildAppStyles = vi.fn(() => Promise.resolve());

    await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink: recordingSink().sink,
        cssEntryExists: () => Promise.resolve(false),
        buildAppStyles,
      }),
    );

    expect(buildAppStyles).not.toHaveBeenCalled();
  });

  it("does nothing when the CSS seams are absent (the default, no CSS pipeline)", async () => {
    const code = await run(
      ["build"],
      depsWith({
        loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
        sink: recordingSink().sink,
      }),
    );

    expect(code).toBe(0);
    expect(lines).toEqual(["built marketing: 1 page"]);
  });

  it("fails with CLI_STYLES_BUILD_FAILED when the compiler throws", async () => {
    const cause = new Error("tailwind blew up");

    try {
      await run(
        ["build"],
        depsWith({
          loadSites: () => Promise.resolve([staticSite("marketing", ["/posts"])]),
          sink: recordingSink().sink,
          cssEntryExists: () => Promise.resolve(true),
          buildAppStyles: () => Promise.reject(cause),
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("CLI_STYLES_BUILD_FAILED");
      expect((error as CliError).details).toMatchObject({
        outDir: "out/marketing",
        mode: "production",
        entry: "app/styles/app.css",
        scanRoot: "app",
        cause,
      });
    }
  });
});

describe("run dev — island client assets", () => {
  const sites: readonly Site[] = [
    { name: "marketing", render: "static", basePath: "/", pages: ["/"] },
  ];

  it("builds the client (dev mode) on boot when app/islands/ exists", async () => {
    const built: Array<{ outDir: string; mode: string; dialect: string }> = [];

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets: (options) => {
          built.push(options);

          return Promise.resolve();
        },
      }),
    );

    expect(built).toEqual([{ outDir: "out", mode: "dev", dialect: "react" }]);
  });

  it("falls back to app-only dispatch when the project declares no sites", async () => {
    const serve = fakeServe(3000);

    // No `lesto.sites.ts` → the bin's loader resolves to `[]`; dev must still serve
    // the app (blocker #9), not 404 every route.
    await run(["dev"], depsWith({ serve, loadSites: () => Promise.resolve([]) }));

    // The app handed to `serve` carries the dev dispatch. A path the app handles
    // is dispatched live, not refused for want of a matching site.
    const [devApp] = serve.mock.calls[0]!;
    const response = await devApp.handle("GET", "/posts");

    expect(response.status).toBe(200);
  });

  it("passes the preact dialect to the client build when ui.dialect is preact", async () => {
    const built: Array<{ outDir: string; mode: string; dialect: string }> = [];

    await run(
      ["dev"],
      depsWith({
        // A lesto() app config that opts into the Preact dialect — the single key
        // that the CLI hands to the client build (the matched pair's client half).
        loadApp: () => Promise.resolve({ ...buildConfig(), ui: { dialect: "preact" as const } }),
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets: (options) => {
          built.push(options);

          return Promise.resolve();
        },
      }),
    );

    expect(built).toEqual([{ outDir: "out", mode: "dev", dialect: "preact" }]);
  });

  it("registers a debounced watcher that rebuilds on change", async () => {
    let onChange: (() => void) | undefined;
    let builds = 0;

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets: () => {
          builds += 1;

          return Promise.resolve();
        },
        watchIslands: (cb) => {
          onChange = cb;

          return () => undefined;
        },
      }),
    );

    // One build on boot; the watcher is registered.
    expect(builds).toBe(1);
    expect(onChange).toBeDefined();

    // A change fires another build (the watcher's debounce lives in the bin's
    // fs.watch wrapper; the core just registers the rebuild closure).
    onChange?.();
    await Promise.resolve();

    expect(builds).toBe(2);
  });

  it("does NOT reload on a clean island rebuild when no overlay is up (leaves island state)", async () => {
    let onChange: (() => void) | undefined;
    const reloads: number[] = [];

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets: () => Promise.resolve(),
        watchIslands: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        liveReload: {
          script: "x",
          notify: () => reloads.push(1),
          notifyError: () => undefined,
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => undefined,
          close: () => undefined,
        },
      }),
    );

    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No prior error → no reload: a clean island save keeps the page (and its island
    // state) as before this overlay existed. HMR (a separate task) is what makes a
    // clean island edit show without a refresh.
    expect(reloads).toEqual([]);
  });

  it("reloads to clear the overlay once a failed island rebuild recovers", async () => {
    let onChange: (() => void) | undefined;
    let calls = 0;
    const reloads: number[] = [];
    const errors: DevError[] = [];

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets: () => {
          calls += 1;

          // Boot OK; first watch rebuild fails (overlay up); second succeeds (recover).
          return calls === 2 ? Promise.reject(new Error("esbuild: oops")) : Promise.resolve();
        },
        watchIslands: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        liveReload: {
          script: "x",
          notify: () => reloads.push(1),
          notifyError: (error) => errors.push(error),
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => undefined,
          close: () => undefined,
        },
      }),
    );

    // First rebuild fails → overlay, no reload.
    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toHaveLength(1);
    expect(reloads).toEqual([]);

    // Second rebuild succeeds → reload, dismissing the overlay (and loading the fix).
    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reloads).toEqual([1]);
  });

  it("paints a dev error overlay when a watched island rebuild fails", async () => {
    let onChange: (() => void) | undefined;
    let calls = 0;
    const errors: DevError[] = [];

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets: () => {
          calls += 1;

          // Boot succeeds; the watch rebuild rejects with the bundler's Error.
          return calls === 1
            ? Promise.resolve()
            : Promise.reject(new Error("esbuild: unexpected }"));
        },
        watchIslands: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        liveReload: {
          script: "x",
          notify: () => undefined,
          notifyError: (error) => errors.push(error),
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => undefined,
          close: () => undefined,
        },
      }),
    );

    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.source).toBe("client-rebuild");
    expect(errors[0]?.message).toBe("esbuild: unexpected }");
    // The CliError wraps the bundler Error as details.cause — its stack is surfaced.
    expect(errors[0]?.stack).toContain("esbuild: unexpected }");
  });

  it("reports a watch-triggered rebuild failure without crashing the dev server", async () => {
    let onChange: (() => void) | undefined;
    let calls = 0;

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets: () => {
          calls += 1;

          // Succeed on boot, fail on the watch rebuild.
          return calls === 1 ? Promise.resolve() : Promise.reject(new Error("rebuild boom"));
        },
        watchIslands: (cb) => {
          onChange = cb;

          return () => undefined;
        },
      }),
    );

    onChange?.();
    // Let the rejected rebuild (hasIslandsDir → buildClientAssets → CliError →
    // .catch) settle across its several microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The coded CliError's `cause` (the bundler's Error) is the message shown.
    expect(lines).toContain("client rebuild failed: rebuild boom");
  });

  it("falls back to the error's string form when the rebuild cause is not an Error", async () => {
    let onChange: (() => void) | undefined;
    let calls = 0;

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets: () => {
          calls += 1;

          // Boot succeeds; the watch rebuild rejects with a non-Error value, so
          // its CliError's `cause` is not an Error → the fallback path.
          // eslint-disable-next-line prefer-promise-reject-errors
          return calls === 1 ? Promise.resolve() : Promise.reject("string failure");
        },
        watchIslands: (cb) => {
          onChange = cb;

          return () => undefined;
        },
      }),
    );

    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No "rebuild boom"; the line carries the CliError's own string form instead.
    expect(lines.some((line) => line.startsWith("client rebuild failed: "))).toBe(true);
    expect(lines).not.toContain("client rebuild failed: string failure");
  });

  it("reports a non-CliError rebuild failure via the error's string form", async () => {
    let onChange: (() => void) | undefined;
    let probes = 0;

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        // First probe (boot) says yes; on the watch rebuild the probe itself
        // rejects — a raw, non-CliError error reaches the rebuild catch.
        hasIslandsDir: () => {
          probes += 1;

          return probes <= 2 ? Promise.resolve(true) : Promise.reject(new Error("probe gone"));
        },
        buildClientAssets: () => Promise.resolve(),
        watchIslands: (cb) => {
          onChange = cb;

          return () => undefined;
        },
      }),
    );

    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The raw error is not a CliError, so its own string form is reported.
    expect(lines).toContain("client rebuild failed: Error: probe gone");
  });

  it("does not watch when app/islands/ is absent", async () => {
    const watchIslands = vi.fn(() => () => undefined);

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        hasIslandsDir: () => Promise.resolve(false),
        buildClientAssets: () => Promise.resolve(),
        watchIslands,
      }),
    );

    expect(watchIslands).not.toHaveBeenCalled();
  });

  it("builds on boot but skips watching when watchIslands is absent", async () => {
    let builds = 0;

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets: () => {
          builds += 1;

          return Promise.resolve();
        },
      }),
    );

    expect(builds).toBe(1);
  });
});

/** A serve fake that captures the app the dev server fronts, so a test can fire
 * requests through the dev dispatch (the forwarding handle + live-reload wrap). */
function capturingServe(): {
  serve: CliDeps["serve"];
  app: () => App;
} {
  let captured: App | undefined;

  const serve = vi.fn((app: App): Promise<Server> => {
    captured = app;

    return Promise.resolve({ port: 3000, close: () => Promise.resolve() });
  });

  return {
    serve: serve as unknown as CliDeps["serve"],
    app: () => {
      if (captured === undefined) throw new Error("serve was never called");

      return captured;
    },
  };
}

/** Parse the tool result text out of an MCP `tools/call` JSON-RPC response. */
async function toolResult(res: Response): Promise<unknown> {
  const message = (await res.json()) as { result?: { content?: { text?: string }[] } };

  return JSON.parse(message.result?.content?.[0]?.text ?? "null");
}

/** A serve fake that captures the options, so a test can invoke the wired `logRequest`. */
function optionCapturingServe(): {
  serve: CliDeps["serve"];
  options: () => ServeOptions | undefined;
} {
  let captured: ServeOptions | undefined;

  const serve = vi.fn((_app: App, options?: ServeOptions): Promise<Server> => {
    captured = options;

    return Promise.resolve({ port: 3000, close: () => Promise.resolve() });
  });

  return { serve: serve as unknown as CliDeps["serve"], options: () => captured };
}

/** A streamed HTML body — React's SSR shape — for the stream-injection test. */
function streamBody(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("<html><body>streamed</body></html>"));
      controller.close();
    },
  });
}

/** Drain a streamed response body to a string. */
async function drainBody(body: unknown): Promise<string> {
  if (typeof body === "string") return body;

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let out = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    out += decoder.decode(value, { stream: true });
  }

  return out + decoder.decode();
}

// A live-reload fake that records every channel call, so the CSS watch's
// hot-swap / reload / overlay routing is asserted exactly.
function recordingLiveReload(): {
  liveReload: NonNullable<CliDeps["liveReload"]>;
  swaps: number;
  reloads: number;
  pageSwaps: number;
  errors: DevError[];
} {
  const rec = { swaps: 0, reloads: 0, pageSwaps: 0, errors: [] as DevError[] };

  return {
    liveReload: {
      script: "x",
      notify: () => (rec.reloads += 1),
      notifyError: (error) => rec.errors.push(error),
      notifyStyleUpdate: () => (rec.swaps += 1),
      notifyPageSwap: () => (rec.pageSwaps += 1),
      close: () => undefined,
    },
    get swaps() {
      return rec.swaps;
    },
    get reloads() {
      return rec.reloads;
    },
    get pageSwaps() {
      return rec.pageSwaps;
    },
    get errors() {
      return rec.errors;
    },
  };
}

// A fake Vite island dev server: spies for the four seams, with `ownsPath` claiming
// everything under the Vite base (as the real predicate does) and `transformHtml`
// marking the document.
function fakeIslandDev(): IslandDevServer & {
  handle: ReturnType<typeof vi.fn>;
  transformHtml: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    ownsPath: (path: string) => path.startsWith("/@lesto-dev/"),
    handle: vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "application/javascript" },
      body: "island-module",
    })),
    transformHtml: vi.fn(async (_url: string, html: string) => `${html}<!--vite-->`),
    close: vi.fn(async () => undefined),
  };
}

// The shape `run`'s `islandDev` factory seam expects.
type IslandDevServer = NonNullable<Awaited<ReturnType<NonNullable<CliDeps["islandDev"]>>>>;

// A one-chunk text/html stream body, so the HTML-transform seam's stream-draining
// branch (a React-streamed document) is exercised, not just the string branch.
function htmlStreamResponse(html: string): {
  status: number;
  headers: { "content-type": string };
  body: ReadableStream<Uint8Array>;
} {
  return {
    status: 200,
    headers: { "content-type": "text/html" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(html));
        controller.close();
      },
    }),
  };
}

describe("run dev — Vite island Fast Refresh (DX-parity R2)", () => {
  // A config whose app answers `/` with a string HTML document and `/posts` with JSON,
  // so the dev path exercises both the HTML-transform seam and its non-HTML passthrough.
  function htmlConfig(): LestoAppConfig {
    return {
      db: adapt(database),
      app: lesto()
        .get("/", (c) => c.html("<html><head></head><body>hi</body></html>"))
        .get("/posts", (c) => c.json({ ok: true })),
      migrations,
    };
  }

  it("lets Vite own islands: skips the Bun build + watch, routes the entry, transforms HTML", async () => {
    const serve = fakeServe(3000);
    const island = fakeIslandDev();
    const islandDev = vi.fn(async () => island);
    const buildClientAssets = vi.fn(() => Promise.resolve());
    const watchIslands = vi.fn(() => () => undefined);

    await run(
      ["dev"],
      depsWith({
        serve,
        loadApp: () => Promise.resolve(htmlConfig()),
        loadSites: () => Promise.resolve([]),
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets,
        watchIslands,
        islandDev,
        liveReload: {
          script: "RELOAD",
          notify: () => undefined,
          notifyError: () => undefined,
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => undefined,
          close: () => undefined,
        },
      }),
    );

    // The factory got the config-derived dialect; Vite owns islands, so the Bun client
    // build and the island watcher are both skipped.
    expect(islandDev).toHaveBeenCalledWith({ dialect: "react" });
    expect(buildClientAssets).not.toHaveBeenCalled();
    expect(watchIslands).not.toHaveBeenCalled();

    const [app] = serve.mock.calls[0]!;

    // A Vite-owned request (under the base) is served by the island dev server, not
    // the app/readAsset.
    const entryResponse = await app.handle("GET", "/@lesto-dev/client.js");
    expect(entryResponse.body).toBe("island-module");
    expect(island.handle).toHaveBeenCalledTimes(1);

    // An HTML response is transformed (Vite client + preamble), then the live-reload
    // script is appended — the two compose.
    const page = await app.handle("GET", "/");
    expect(page.body).toBe(
      "<html><head></head><body>hi</body></html><!--vite--><script>RELOAD</script>",
    );
    expect(island.transformHtml).toHaveBeenCalledTimes(1);

    // A non-HTML response passes the transform seam through untouched.
    const json = await app.handle("GET", "/posts");
    expect(JSON.parse(json.body as string)).toEqual({ ok: true });
    expect(island.transformHtml).toHaveBeenCalledTimes(1);
  });

  it("buffers a streamed HTML document before transforming it", async () => {
    const serve = fakeServe(3000);
    const island = fakeIslandDev();

    await run(
      ["dev"],
      depsWith({
        serve,
        loadApp: () =>
          Promise.resolve({
            db: adapt(database),
            app: lesto().get(
              "/",
              () => htmlStreamResponse("<html><body>streamed</body></html>") as never,
            ),
            migrations,
          }),
        loadSites: () => Promise.resolve([]),
        islandDev: async () => island,
      }),
    );

    const [app] = serve.mock.calls[0]!;
    const page = await app.handle("GET", "/");

    // The whole streamed document reached `transformHtml` as a string, marked once.
    expect(island.transformHtml).toHaveBeenCalledWith("/", "<html><body>streamed</body></html>");
    expect(page.body).toBe("<html><body>streamed</body></html><!--vite-->");
  });

  it("falls back to the Bun island path when the @lesto/island-dev peer is absent", async () => {
    const serve = fakeServe(3000);
    const buildClientAssets = vi.fn(() => Promise.resolve());
    // The factory resolves `undefined` exactly as the bin does when the peer is not installed.
    const islandDev = vi.fn(async () => undefined);

    await run(
      ["dev"],
      depsWith({
        serve,
        loadSites: () => Promise.resolve([]),
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets,
        islandDev,
      }),
    );

    expect(islandDev).toHaveBeenCalledTimes(1);

    // No Vite server → the Bun client build runs, exactly as before this task.
    expect(buildClientAssets).toHaveBeenCalledTimes(1);

    // And no island routing wraps the dispatch: the entry path falls through to
    // readAsset (absent here → the app's 404), not a Vite handler.
    const [app] = serve.mock.calls[0]!;
    const entryResponse = await app.handle("GET", "/client.js");
    expect(entryResponse.status).toBe(404);
  });

  it("falls back to the Bun path (not a crash) when the Vite server fails to start", async () => {
    const serve = fakeServe(3000);
    const buildClientAssets = vi.fn(() => Promise.resolve());
    // The one degradable signal: `ISLAND_DEV_SERVER_FAILED` carries the Vite/port throw as
    // `details.cause`. Must NOT crash dev boot — degrade to the Bun path with a logged note.
    const islandDev = vi.fn(async () => {
      throw new LestoError(
        "ISLAND_DEV_SERVER_FAILED",
        "the island dev server (Vite) failed to start",
        { cause: new Error("EADDRINUSE: hmr port 24678 in use") },
      );
    });

    const code = await run(
      ["dev"],
      depsWith({
        serve,
        loadSites: () => Promise.resolve([]),
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets,
        islandDev,
      }),
    );

    // Dev still booted; the Bun client build ran; the failure was logged, not thrown.
    expect(code).toBe(0);
    expect(buildClientAssets).toHaveBeenCalledTimes(1);

    // The note surfaced the UNWRAPPED cause (Amendment B), not the generic wrapper prose —
    // so the actionable "EADDRINUSE …" reaches the author.
    const note = lines.find((line) => line.includes("island Fast Refresh unavailable"));
    expect(note).toBeDefined();
    expect(note).toContain("EADDRINUSE");
  });

  it("re-throws (does NOT degrade) a missing-RUM-dependency error from the island dev server", async () => {
    const serve = fakeServe(3000);
    const buildClientAssets = vi.fn(() => Promise.resolve());
    // The default `lesto dev` Vite path's RUM preflight refusing (L-44ca7c57): missing
    // `@lesto/observability` is fatal on the Bun fallback TOO, so degrading it would only hide the
    // actionable error behind the misleading "full reload" note. Dev boot must fail loud.
    const rumError = new AssetsError(
      "ASSETS_MISSING_RUM_DEPENDENCY",
      `the client entry imports "@lesto/observability/rum" — but "@lesto/observability" does not resolve.`,
      { module: "@lesto/observability/rum", dependency: "@lesto/observability" },
    );
    const islandDev = vi.fn(async () => {
      throw rumError;
    });

    await expect(
      run(
        ["dev"],
        depsWith({
          serve,
          loadSites: () => Promise.resolve([]),
          hasIslandsDir: () => Promise.resolve(true),
          buildClientAssets,
          islandDev,
        }),
      ),
    ).rejects.toBe(rumError);

    // It did NOT degrade: no fallback log, no Bun build, no server stood up.
    expect(lines.some((line) => line.includes("island Fast Refresh unavailable"))).toBe(false);
    expect(buildClientAssets).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });

  it("re-throws (does NOT degrade) an unknown-dialect error from the island dev server", async () => {
    const serve = fakeServe(3000);
    const buildClientAssets = vi.fn(() => Promise.resolve());
    // Fatal-by-default under the allowlist: ONLY `ISLAND_DEV_SERVER_FAILED` degrades. An unknown
    // `ui.dialect` is a real, REACHABLE misconfiguration: `dialectOf`'s `UiDialect` return is
    // compile-time only and `createApp` does NOT validate `ui.dialect`, so an untyped/JS config with
    // `ui.dialect: "vue"` reaches island-dev at runtime — fail dev boot loud, never silently degrade.
    const dialectError = new LestoError(
      "ISLAND_DEV_UNKNOWN_DIALECT",
      "the configured ui.dialect is neither react nor preact",
    );
    const islandDev = vi.fn(async () => {
      throw dialectError;
    });

    await expect(
      run(
        ["dev"],
        depsWith({
          serve,
          loadSites: () => Promise.resolve([]),
          hasIslandsDir: () => Promise.resolve(true),
          buildClientAssets,
          islandDev,
        }),
      ),
    ).rejects.toBe(dialectError);

    // It did NOT degrade: no fallback log, no Bun build, no server stood up.
    expect(lines.some((line) => line.includes("island Fast Refresh unavailable"))).toBe(false);
    expect(buildClientAssets).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });

  it("re-throws (does NOT degrade) an uncoded error from the island dev server", async () => {
    const serve = fakeServe(3000);
    const buildClientAssets = vi.fn(() => Promise.resolve());
    // The load-bearing inversion pin: an UNCODED throw (e.g. a broken transitive inside the
    // installed peer) is NOT the `ISLAND_DEV_SERVER_FAILED` allowlist signal, so it is FATAL —
    // the OPPOSITE of the old denylist, which degraded every uncoded error to full reload.
    const rawError = new Error("boom inside the installed peer");
    const islandDev = vi.fn(async () => {
      throw rawError;
    });

    await expect(
      run(
        ["dev"],
        depsWith({
          serve,
          loadSites: () => Promise.resolve([]),
          hasIslandsDir: () => Promise.resolve(true),
          buildClientAssets,
          islandDev,
        }),
      ),
    ).rejects.toBe(rawError);

    // It did NOT degrade: no fallback log, no Bun build, no server stood up.
    expect(lines.some((line) => line.includes("island Fast Refresh unavailable"))).toBe(false);
    expect(buildClientAssets).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });

  it("degrades an ISLAND_DEV_SERVER_FAILED with no cause via the error's own message", async () => {
    const serve = fakeServe(3000);
    const buildClientAssets = vi.fn(() => Promise.resolve());
    // Amendment B's else branch: the signal still degrades even with NO `Error` cause in
    // `details` — the note falls back to the error's own message (not a wrapped cause).
    const islandDev = vi.fn(async () => {
      throw new LestoError(
        "ISLAND_DEV_SERVER_FAILED",
        "the island dev server (Vite) failed to start",
      );
    });

    const code = await run(
      ["dev"],
      depsWith({
        serve,
        loadSites: () => Promise.resolve([]),
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets,
        islandDev,
      }),
    );

    // Degraded (exit 0, Bun build ran) and the note carries the error's OWN message.
    expect(code).toBe(0);
    expect(buildClientAssets).toHaveBeenCalledTimes(1);
    const note = lines.find((line) => line.includes("island Fast Refresh unavailable"));
    expect(note).toContain("the island dev server (Vite) failed to start");
  });

  it("closes the Vite island server on graceful shutdown", async () => {
    const serve = fakeServe(3000);
    const island = fakeIslandDev();
    const installShutdown = vi.fn();

    await run(
      ["dev"],
      depsWith({
        serve,
        loadSites: () => Promise.resolve([]),
        islandDev: async () => island,
        installShutdown,
      }),
    );

    const drain = installShutdown.mock.calls[0]![0] as () => Promise<void>;
    await drain();

    expect(island.close).toHaveBeenCalledTimes(1);
  });
});

describe("run dev — Tailwind CSS (ADR 0037)", () => {
  const sites: readonly Site[] = [
    { name: "marketing", render: "static", basePath: "/", pages: ["/"] },
  ];

  it("builds the stylesheet (dev mode) on boot when the CSS entry exists", async () => {
    const built: Array<{ entry: string; outDir: string; mode: string }> = [];

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        cssEntryExists: () => Promise.resolve(true),
        buildAppStyles: (options) => {
          built.push(options);

          return Promise.resolve();
        },
      }),
    );

    expect(built).toEqual([
      { entry: "app/styles/app.css", outDir: "out", mode: "dev", scanRoot: "app" },
    ]);
  });

  it("watches the broad app/ source set and hot-swaps the stylesheet on a clean rebuild", async () => {
    let onChange: (() => void) | undefined;
    let builds = 0;
    const rec = recordingLiveReload();

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        cssEntryExists: () => Promise.resolve(true),
        buildAppStyles: () => {
          builds += 1;

          return Promise.resolve();
        },
        watchStyleSources: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        liveReload: rec.liveReload,
      }),
    );

    // One build on boot; the broad-source watcher is registered.
    expect(builds).toBe(1);
    expect(onChange).toBeDefined();

    // A class edit anywhere under app/ rebuilds the CSS and HOT-SWAPS the <link>
    // (no reload), preserving island state.
    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(builds).toBe(2);
    expect(rec.swaps).toBe(1);
    expect(rec.reloads).toBe(0);
  });

  it("hot-swap is an inert no-op when no live-reload channel is wired", async () => {
    let onChange: (() => void) | undefined;
    let builds = 0;

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        cssEntryExists: () => Promise.resolve(true),
        buildAppStyles: () => {
          builds += 1;

          return Promise.resolve();
        },
        watchStyleSources: (cb) => {
          onChange = cb;

          return () => undefined;
        },
      }),
    );

    // A clean rebuild with no live-reload channel must not throw (the swap short-circuits).
    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(builds).toBe(2);
  });

  it("paints a dev error overlay (source style-rebuild) when a watched CSS rebuild fails", async () => {
    let onChange: (() => void) | undefined;
    let calls = 0;
    const rec = recordingLiveReload();

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        cssEntryExists: () => Promise.resolve(true),
        buildAppStyles: () => {
          calls += 1;

          // Boot OK; the watch rebuild fails (a bad @theme/@import).
          return calls === 2
            ? Promise.reject(new Error("tailwind: bad @theme"))
            : Promise.resolve();
        },
        watchStyleSources: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        liveReload: rec.liveReload,
      }),
    );

    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rec.errors).toHaveLength(1);
    expect(rec.errors[0]?.source).toBe("style-rebuild");
    expect(rec.errors[0]?.message).toContain("tailwind: bad @theme");
    expect(rec.swaps).toBe(0);
  });

  it("reloads to clear the overlay once a failed CSS rebuild recovers", async () => {
    let onChange: (() => void) | undefined;
    let calls = 0;
    const rec = recordingLiveReload();

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        cssEntryExists: () => Promise.resolve(true),
        buildAppStyles: () => {
          calls += 1;

          // Boot OK; first watch rebuild fails (overlay up); second succeeds (recover).
          return calls === 2 ? Promise.reject(new Error("tailwind boom")) : Promise.resolve();
        },
        watchStyleSources: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        liveReload: rec.liveReload,
      }),
    );

    // First rebuild fails → overlay, no swap, no reload.
    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rec.errors).toHaveLength(1);
    expect(rec.reloads).toBe(0);

    // Second rebuild succeeds while the overlay is up → reload (clears it), not a
    // silent hot-swap that would leave the stale error painted.
    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rec.reloads).toBe(1);
    expect(rec.swaps).toBe(0);
  });

  it("does NOT register a CSS watcher when the entry is absent (Tailwind opt-in)", async () => {
    const watchStyleSources = vi.fn(() => () => undefined);

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        cssEntryExists: () => Promise.resolve(false),
        buildAppStyles: () => Promise.resolve(),
        watchStyleSources,
      }),
    );

    expect(watchStyleSources).not.toHaveBeenCalled();
  });
});

describe("run routes:gen", () => {
  it("regenerates the manifest and reports the path + count", async () => {
    const code = await run(
      ["routes:gen"],
      depsWith({
        regenerateRoutes: () => Promise.resolve({ path: "src/routes.gen.ts", count: 3 }),
      }),
    );

    expect(code).toBe(0);
    expect(lines).toEqual(["generated src/routes.gen.ts (3 route files)"]);
  });

  it("uses the singular noun for a one-file manifest", async () => {
    await run(
      ["routes:gen"],
      depsWith({
        regenerateRoutes: () => Promise.resolve({ path: "src/routes.gen.ts", count: 1 }),
      }),
    );

    expect(lines).toEqual(["generated src/routes.gen.ts (1 route file)"]);
  });

  it("says nothing-to-generate when there is no app/routes/", async () => {
    await run(["routes:gen"], depsWith({ regenerateRoutes: () => Promise.resolve(undefined) }));

    expect(lines).toEqual(["no app/routes/ directory — nothing to generate"]);
  });

  it("reports when the seam is not wired at all", async () => {
    // `depsWith` omits `regenerateRoutes`, so the command sees the seam as absent.
    await run(["routes:gen"], depsWith());

    expect(lines).toEqual(["routes:gen is not available in this environment"]);
  });
});

describe("run dev — route watching & live reload (Workstream 3)", () => {
  const sites: readonly Site[] = [{ name: "app", render: "dynamic", basePath: "/" }];

  it("registers a route watcher and, on change, refreshes the manifest, reloads the app, and swaps the page", async () => {
    let onChange: (() => void) | undefined;
    let regenerated = 0;
    let reloaded = 0;
    const reloads: number[] = [];
    const pageSwaps: number[] = [];

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        watchRoutes: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        regenerateRoutes: () => {
          regenerated += 1;

          return Promise.resolve({ path: "src/routes.gen.ts", count: 2 });
        },
        reloadApp: () => {
          reloaded += 1;

          return Promise.resolve(buildConfig());
        },
        liveReload: {
          script: "x",
          notify: () => reloads.push(1),
          notifyError: () => undefined,
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => pageSwaps.push(1),
          close: () => undefined,
        },
      }),
    );

    expect(onChange).toBeDefined();

    onChange?.();
    // Let the async refresh settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(regenerated).toBe(1);
    expect(reloaded).toBe(1);
    // A clean route edit with no overlay up swaps the page in place — NOT a full reload.
    expect(pageSwaps).toEqual([1]);
    expect(reloads).toEqual([]);
    expect(lines).toContain("routes refreshed: src/routes.gen.ts (2 route files)");
  });

  it("swaps the live server's handle so a re-loaded app's new route serves without a restart", async () => {
    let onChange: (() => void) | undefined;
    const capture = capturingServe();

    // The re-loaded config adds a route the boot app did not have.
    const reloadedConfig = (): LestoAppConfig => {
      const base = buildConfig();
      base.app.get("/brand-new", (c) => c.json({ fresh: true }));

      return base;
    };

    await run(
      ["dev"],
      depsWith({
        serve: capture.serve,
        loadSites: () => Promise.resolve(sites),
        watchRoutes: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        reloadApp: () => Promise.resolve(reloadedConfig()),
      }),
    );

    // Before the change, the new route is a 404 (the boot app never had it).
    expect((await capture.app().handle("GET", "/brand-new")).status).toBe(404);

    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // After the re-load, the forwarder points at the new app, so the route serves.
    expect((await capture.app().handle("GET", "/brand-new")).status).toBe(200);
  });

  it("keeps the dev server up when a route re-load throws, reporting the failure", async () => {
    let onChange: (() => void) | undefined;

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        watchRoutes: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        reloadApp: () => Promise.reject(new Error("syntax error in page.tsx")),
      }),
    );

    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lines.some((line) => line.startsWith("app reload failed:"))).toBe(true);
  });

  it("reports a manifest refresh failure on stderr but does NOT overlay it (the app reloaded fine)", async () => {
    let onChange: (() => void) | undefined;
    const reloads: number[] = [];
    const pageSwaps: number[] = [];
    const errors: DevError[] = [];

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        watchRoutes: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        // The edge manifest regen fails, but the app itself re-loads fine: the running
        // dev page works, so this must NOT paint a blocking overlay — only a stderr line.
        regenerateRoutes: () => Promise.reject(new Error("scan blew up")),
        reloadApp: () => Promise.resolve(buildConfig()),
        liveReload: {
          script: "x",
          notify: () => reloads.push(1),
          notifyError: (error) => errors.push(error),
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => pageSwaps.push(1),
          close: () => undefined,
        },
      }),
    );

    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lines.some((line) => line.startsWith("route manifest refresh failed:"))).toBe(true);
    // A stale edge map does not break the page → swap (no overlay, no full reload).
    expect(errors).toEqual([]);
    expect(pageSwaps).toEqual([1]);
    expect(reloads).toEqual([]);
  });

  it("swaps the page on a clean refresh even with no app re-scan seam (manifest only)", async () => {
    let onChange: (() => void) | undefined;
    const reloads: number[] = [];
    const pageSwaps: number[] = [];

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        watchRoutes: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        regenerateRoutes: () => Promise.resolve({ path: "src/routes.gen.ts", count: 1 }),
        // No `reloadApp` seam → refreshRoutes returns neither a handle nor an error;
        // the clean refresh still swaps the page (no overlay up → no full reload).
        liveReload: {
          script: "x",
          notify: () => reloads.push(1),
          notifyError: () => undefined,
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => pageSwaps.push(1),
          close: () => undefined,
        },
      }),
    );

    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pageSwaps).toEqual([1]);
    expect(reloads).toEqual([]);
  });

  it("does a FULL reload (not a page swap) on a clean refresh that clears a prior overlay", async () => {
    let onChange: (() => void) | undefined;
    let shouldFail = true;
    const reloads: number[] = [];
    const pageSwaps: number[] = [];
    const errors: DevError[] = [];

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        watchRoutes: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        // First refresh throws (paints the overlay); the second succeeds.
        reloadApp: () =>
          shouldFail
            ? Promise.reject(new Error("boom in page.tsx"))
            : Promise.resolve(buildConfig()),
        liveReload: {
          script: "x",
          notify: () => reloads.push(1),
          notifyError: (error) => errors.push(error),
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => pageSwaps.push(1),
          close: () => undefined,
        },
      }),
    );

    // First change fails → overlay up, neither reload nor swap.
    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect(reloads).toEqual([]);
    expect(pageSwaps).toEqual([]);

    // Second change succeeds while the overlay is up → a FULL reload clears it (a page
    // swap would leave the failed build's overlay element on screen).
    shouldFail = false;
    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reloads).toEqual([1]);
    expect(pageSwaps).toEqual([]);
  });

  it("paints a dev error overlay (and does NOT reload) when the app reload fails", async () => {
    let onChange: (() => void) | undefined;
    const reloads: number[] = [];
    const errors: DevError[] = [];

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        watchRoutes: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        reloadApp: () => Promise.reject(new Error("Unexpected token in page.tsx")),
        liveReload: {
          script: "x",
          notify: () => reloads.push(1),
          notifyError: (error) => errors.push(error),
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => undefined,
          close: () => undefined,
        },
      }),
    );

    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A failure becomes an overlay, NOT a reload — a reload would re-paint the stale
    // app and hide that the save did not take.
    expect(reloads).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.source).toBe("app-reload");
    expect(errors[0]?.message).toBe("Unexpected token in page.tsx");
    // A real Error carries a stack, surfaced for the overlay's <pre>.
    expect(errors[0]?.stack).toContain("Unexpected token in page.tsx");
  });

  it("paints an overlay with NO stack when the failure is not an Error", async () => {
    let onChange: (() => void) | undefined;
    const errors: DevError[] = [];

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        watchRoutes: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        // A non-Error throw (a bare string) carries no frames — the overlay omits stack.
        // eslint-disable-next-line prefer-promise-reject-errors
        reloadApp: () => Promise.reject("kaboom"),
        liveReload: {
          script: "x",
          notify: () => undefined,
          notifyError: (error) => errors.push(error),
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => undefined,
          close: () => undefined,
        },
      }),
    );

    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.source).toBe("app-reload");
    expect(errors[0]?.message).toBe("kaboom");
    expect(errors[0]?.stack).toBeUndefined();
  });

  it("does not log a refresh line when there is no app/routes/ to regenerate", async () => {
    let onChange: (() => void) | undefined;

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        watchRoutes: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        regenerateRoutes: () => Promise.resolve(undefined),
        reloadApp: () => Promise.resolve(buildConfig()),
      }),
    );

    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lines.some((line) => line.startsWith("routes refreshed:"))).toBe(false);
  });

  it("injects the live-reload script into an HTML response", async () => {
    const capture = capturingServe();

    await run(
      ["dev"],
      depsWith({
        serve: capture.serve,
        loadApp: () =>
          Promise.resolve({
            ...buildConfig(),
            app: lesto().get("/page", () => ({
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
              body: "<html><body>hi</body></html>",
            })),
          }),
        loadSites: () => Promise.resolve(sites),
        liveReload: {
          script: "RELOAD_ME();",
          notify: () => undefined,
          notifyError: () => undefined,
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => undefined,
          close: () => undefined,
        },
      }),
    );

    const response = await capture.app().handle("GET", "/page");
    const html = await drainBody(response.body);

    expect(html).toContain("<script>RELOAD_ME();</script>");
    expect(html).toContain("<html><body>hi</body></html>");
  });

  it("injects the live-reload script into a STREAMED HTML response", async () => {
    const capture = capturingServe();

    await run(
      ["dev"],
      depsWith({
        serve: capture.serve,
        loadApp: () =>
          Promise.resolve({
            ...buildConfig(),
            app: lesto().get("/stream", () => ({
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
              body: streamBody() as unknown as string,
            })),
          }),
        loadSites: () => Promise.resolve(sites),
        liveReload: {
          script: "STREAM_RELOAD();",
          notify: () => undefined,
          notifyError: () => undefined,
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => undefined,
          close: () => undefined,
        },
      }),
    );

    const response = await capture.app().handle("GET", "/stream");
    const html = await drainBody(response.body);

    expect(html).toContain("streamed");
    expect(html).toContain("<script>STREAM_RELOAD();</script>");
  });

  it("leaves a non-HTML (JSON) response untouched", async () => {
    const capture = capturingServe();

    await run(
      ["dev"],
      depsWith({
        serve: capture.serve,
        loadSites: () => Promise.resolve(sites),
        liveReload: {
          script: "NO();",
          notify: () => undefined,
          notifyError: () => undefined,
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => undefined,
          close: () => undefined,
        },
      }),
    );

    const response = await capture.app().handle("GET", "/posts");
    const body = await drainBody(response.body);

    // `/posts` returns JSON; the reload script must not be injected.
    expect(body).not.toContain("NO();");
    expect(body).toContain("posts");
  });

  it("treats an array content-type header (its first value) as HTML for injection", async () => {
    const capture = capturingServe();

    await run(
      ["dev"],
      depsWith({
        serve: capture.serve,
        loadApp: () =>
          Promise.resolve({
            ...buildConfig(),
            app: lesto().get("/multi", () => ({
              status: 200,
              headers: { "content-type": ["text/html; charset=utf-8"] },
              body: "<html></html>",
            })),
          }),
        loadSites: () => Promise.resolve(sites),
        liveReload: {
          script: "ARR();",
          notify: () => undefined,
          notifyError: () => undefined,
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => undefined,
          close: () => undefined,
        },
      }),
    );

    const response = await capture.app().handle("GET", "/multi");

    expect(await drainBody(response.body)).toContain("<script>ARR();</script>");
  });

  it("leaves a response with NO content-type untouched", async () => {
    const capture = capturingServe();

    await run(
      ["dev"],
      depsWith({
        serve: capture.serve,
        loadApp: () =>
          Promise.resolve({
            ...buildConfig(),
            app: lesto().get("/bare", () => ({ status: 204, headers: {}, body: "" })),
          }),
        loadSites: () => Promise.resolve(sites),
        liveReload: {
          script: "BARE();",
          notify: () => undefined,
          notifyError: () => undefined,
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => undefined,
          close: () => undefined,
        },
      }),
    );

    const response = await capture.app().handle("GET", "/bare");

    expect(await drainBody(response.body)).not.toContain("BARE();");
  });

  it("stops the route watcher and closes live reload on shutdown", async () => {
    let stopped = false;
    let closed = false;
    let drain: (() => Promise<void>) | undefined;

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(3000),
        loadSites: () => Promise.resolve(sites),
        watchRoutes: () => () => {
          stopped = true;
        },
        liveReload: {
          script: "x",
          notify: () => undefined,
          notifyError: () => undefined,
          notifyStyleUpdate: () => undefined,
          notifyPageSwap: () => undefined,
          close: () => {
            closed = true;
          },
        },
        installShutdown: (d) => {
          drain = d;
        },
      }),
    );

    expect(drain).toBeDefined();
    await drain?.();

    expect(stopped).toBe(true);
    expect(closed).toBe(true);
  });

  it("runs dev with neither route watching nor live reload (the unchanged default)", async () => {
    const capture = capturingServe();

    // No watchRoutes / liveReload seams: the forwarder still serves, untouched.
    await run(["dev"], depsWith({ serve: capture.serve, loadSites: () => Promise.resolve(sites) }));

    const response = await capture.app().handle("GET", "/posts");

    expect(response.status).toBe(200);
  });
});

// A capturing uploader: every shipped key lands in the map.
function recordingUploader(): {
  uploader: CliDeps["uploader"];
  shipped: Map<string, string>;
  distDirs: string[];
} {
  const shipped = new Map<string, string>();
  const distDirs: string[] = [];

  const uploader: CliDeps["uploader"] = (distDir) => {
    distDirs.push(distDir);

    return {
      read: (_outRoot, file) => Promise.resolve(new TextEncoder().encode(`bytes:${file}`)),
      put: (key, contents: Uint8Array | string) => {
        shipped.set(
          key,
          typeof contents === "string" ? contents : new TextDecoder().decode(contents),
        );

        return Promise.resolve();
      },
    };
  };

  return { uploader, shipped, distDirs };
}

describe("run dev — dev-state ring (ADR 0032 Phase 1)", () => {
  const sites: readonly Site[] = [
    { name: "marketing", render: "static", basePath: "/", pages: ["/"] },
  ];

  it("feeds the ring: served requests, the route-refresh log, and the DevError it later clears", async () => {
    const devState = createDevState();
    const capture = optionCapturingServe();
    let onChange: (() => void) | undefined;

    // First refresh fails (overlay → error recorded); the second succeeds (clears it).
    let reloads = 0;
    const reloadApp = (): Promise<LestoAppConfig> => {
      reloads += 1;

      return reloads === 1
        ? Promise.reject(new Error("syntax error in page.tsx"))
        : Promise.resolve(buildConfig());
    };

    await run(
      ["dev"],
      depsWith({
        serve: capture.serve,
        loadSites: () => Promise.resolve(sites),
        devState,
        watchRoutes: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        regenerateRoutes: () => Promise.resolve({ path: "src/routes.gen.ts", count: 2 }),
        reloadApp,
      }),
    );

    // The access-log seam is wired only with a ring; feed it one request → the ring.
    expect(capture.options()?.logRequest).toBeDefined();
    capture.options()?.logRequest?.({
      method: "GET",
      path: "/posts",
      status: 200,
      ms: 4,
      requestId: "req-1",
    });
    expect(devState.recentRequests(10).map((record) => record.requestId)).toEqual(["req-1"]);
    expect(devState.spanFor("req-1")?.status).toBe(200);

    // Route change #1 fails → the ring records the app-reload DevError + the refresh log.
    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(devState.getDiagnostics()?.source).toBe("app-reload");
    expect(devState.recentLogs(20)).toContain(
      "routes refreshed: src/routes.gen.ts (2 route files)",
    );

    // Route change #2 succeeds → the overlay clears, so the ring's error clears too.
    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(devState.getDiagnostics()).toBeUndefined();
  });

  it("leaves the default access log untouched when no ring is wired (unchanged behaviour)", async () => {
    const capture = optionCapturingServe();

    await run(["dev"], depsWith({ serve: capture.serve, loadSites: () => Promise.resolve(sites) }));

    // No ring → no `logRequest` override → the runtime's default access log stands.
    expect(capture.options()?.logRequest).toBeUndefined();
  });

  it("stands the dev MCP server up via the injected seam — once, with the live app/routes/ring — then closes it on shutdown", async () => {
    const devState = createDevState();
    const close = vi.fn(() => Promise.resolve());
    const startDevMcp = vi.fn((_params: Parameters<NonNullable<CliDeps["startDevMcp"]>>[0]) =>
      Promise.resolve({ close }),
    );
    const installShutdown = vi.fn();

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(5173),
        loadSites: () => Promise.resolve(sites),
        devState,
        startDevMcp,
        installShutdown,
      }),
    );

    // Called once, after the app loaded, with LIVE app + routes thunks + the SAME ring runDev
    // fills — so the app boots once (no double-boot) and the server reads what the watcher writes.
    expect(startDevMcp).toHaveBeenCalledTimes(1);
    const params = startDevMcp.mock.calls[0]![0];
    expect(typeof params.app().handle).toBe("function");
    expect(Array.isArray(params.routes())).toBe(true);
    expect(params.devState).toBe(devState);

    // The handle's `close` is wired into the dev shutdown drain.
    const drain = installShutdown.mock.calls[0]![0] as () => Promise<void>;
    await drain();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("hands the dev MCP LIVE route/app thunks so a hot reload keeps list_routes current (L-eef18974)", async () => {
    let onChange: (() => void) | undefined;
    let captured: Parameters<NonNullable<CliDeps["startDevMcp"]>>[0] | undefined;

    // The re-loaded config adds a route the boot app did not have.
    const reloadedConfig = (): LestoAppConfig => {
      const base = buildConfig();
      base.app.get("/brand-new", (c) => c.json({ fresh: true }));

      return base;
    };

    await run(
      ["dev"],
      depsWith({
        serve: fakeServe(5173),
        loadSites: () => Promise.resolve(sites),
        devState: createDevState(),
        watchRoutes: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        reloadApp: () => Promise.resolve(reloadedConfig()),
        startDevMcp: (params) => {
          captured = params;

          return Promise.resolve({ close: () => Promise.resolve() });
        },
      }),
    );

    // The boot snapshot: `/brand-new` is not yet a route, and the live app 404s it.
    expect(captured?.routes().some((route) => route.pattern === "/brand-new")).toBe(false);
    expect((await captured!.app().handle("GET", "/brand-new")).status).toBe(404);

    // A hot route reload swaps the forwarder's app; the SAME thunks now read the new set.
    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(captured?.routes().some((route) => route.pattern === "/brand-new")).toBe(true);
    expect((await captured!.app().handle("GET", "/brand-new")).status).toBe(200);
  });

  it("tears the already-started dev server + watchers down if startDevMcp rejects (L-6e3d5e67)", async () => {
    const serverClose = vi.fn(() => Promise.resolve());
    const stopRoutes = vi.fn();
    const reloadClose = vi.fn();
    const installShutdown = vi.fn();

    // Inject the tracing seam so the flush-cadence `stopInterval()` the failure-path
    // teardown calls is a spy we can assert fired — a real `unref`'d interval is
    // otherwise unobservable, so a regression that dropped the call would stay green.
    const { buildServeTracing, stopInterval } = fakeServeTracing();

    let caught: unknown;

    try {
      await run(
        ["dev"],
        depsWith({
          buildServeTracing,
          serve: () => Promise.resolve({ port: 5173, close: serverClose }),
          loadSites: () => Promise.resolve(sites),
          devState: createDevState(),
          watchRoutes: () => stopRoutes,
          liveReload: {
            script: "x",
            notify: () => undefined,
            notifyError: () => undefined,
            notifyStyleUpdate: () => undefined,
            notifyPageSwap: () => undefined,
            close: reloadClose,
          },
          startDevMcp: () => Promise.reject(new Error("EADDRINUSE: reload port busy")),
          installShutdown,
        }),
      );
    } catch (error) {
      caught = error;
    }

    // The rejection propagates (the dev boot fails loudly)…
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("EADDRINUSE");

    // …after tearing every already-started resource down, so nothing is stranded.
    expect(serverClose).toHaveBeenCalledTimes(1);
    expect(stopRoutes).toHaveBeenCalledTimes(1);
    expect(reloadClose).toHaveBeenCalledTimes(1);

    // …including the trace-flush cadence: teardown calls `stopInterval()`, so the
    // (unref'd) interval never leaks past a failed dev boot (L-fe2da7f5) — and it
    // closes the server (its final drain flush) BEFORE stopping the cadence.
    expect(stopInterval).toHaveBeenCalledTimes(1);
    expect(serverClose.mock.invocationCallOrder[0]!).toBeLessThan(
      stopInterval.mock.invocationCallOrder[0]!,
    );

    // The shutdown hook is never reached, since teardown already ran on the failure path.
    expect(installShutdown).not.toHaveBeenCalled();
  });

  // THE COMMITTED QA GATE (ADR 0032 Phase 1 Inc 6): drive `runDev` to fill the ring,
  // stand a REAL loopback dev MCP server over that same ring, and read it back over the
  // wire — proving the end-to-end (runDev fills → MCP reads) path plus the security gate
  // and the audit. Lives here (not a separate file) to reuse the `depsWith` dev harness.
  it("serves the live dev state over the loopback MCP transport, gated + audited", async () => {
    const devState = createDevState();
    const capture = optionCapturingServe();
    let onChange: (() => void) | undefined;

    await run(
      ["dev"],
      depsWith({
        serve: capture.serve,
        loadSites: () => Promise.resolve(sites),
        devState,
        watchRoutes: (cb) => {
          onChange = cb;

          return () => undefined;
        },
        regenerateRoutes: () => Promise.resolve({ path: "src/routes.gen.ts", count: 2 }),
        // Fail the route re-load so the ring records a DevError the tool reads back.
        reloadApp: () => Promise.reject(new Error("syntax error in page.tsx")),
      }),
    );

    // runDev fills the ring: one served request, then a failed route change.
    capture.options()?.logRequest?.({
      method: "GET",
      path: "/posts",
      status: 200,
      ms: 4,
      requestId: "req-1",
    });
    onChange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Stand a REAL loopback dev MCP server over the SAME ring (what the bin wires in Inc 4b).
    const audited: McpAuditRecord[] = [];
    const devContext: LestoMcpContext = {
      app: {
        handle: () => Promise.resolve({ status: 200, headers: {}, body: "" }),
      } as unknown as App,
      routes: [],
      audit: (record) => void audited.push(record),
      devState,
    };
    // A real minted token clears the construction-time length floor (MIN_DEV_TOKEN_LENGTH).
    const devToken = "dev-token-".repeat(4);
    const handle = await startMcpHttpServer(devContext, { token: devToken, port: 0 });

    const base = `http://127.0.0.1:${handle.port}/`;
    const call = (name: string, extraHeaders: Record<string, string> = {}): Promise<Response> =>
      fetch(base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-lesto-dev-token": devToken,
          ...extraHeaders,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      });

    try {
      // get_dev_diagnostics → the app-reload DevError runDev recorded.
      const diagnostics = (await toolResult(await call("get_dev_diagnostics"))) as DevError;
      expect(diagnostics.source).toBe("app-reload");

      // get_recent_requests → the access entry the serve seam fed the ring.
      const requests = (await toolResult(await call("get_recent_requests"))) as {
        requestId: string;
      }[];
      expect(requests.map((record) => record.requestId)).toEqual(["req-1"]);

      // tail_logs → the route-refresh activity line.
      const logs = (await toolResult(await call("tail_logs"))) as string[];
      expect(logs).toContain("routes refreshed: src/routes.gen.ts (2 route files)");

      // A foreign-Origin call is refused with MCP_DEV_ORIGIN_REJECTED before any dispatch.
      const rejected = await call("get_dev_diagnostics", { origin: "https://evil.example" });
      expect(rejected.status).toBe(403);
      expect((await rejected.json()) as unknown).toMatchObject({
        error: "MCP_DEV_ORIGIN_REJECTED",
      });

      // Every accepted tools/call was audited; the rejected one never reached dispatch.
      expect(audited.map((record) => record.tool)).toEqual([
        "get_dev_diagnostics",
        "get_recent_requests",
        "tail_logs",
      ]);
      expect(audited.every((record) => record.outcome === "ok")).toBe(true);
    } finally {
      await handle.close();
    }
  });
});

// A live-reload seam whose injected script is a recognizable marker (module scope: it
// captures nothing from the describe).
function reloadSeam(script: string): NonNullable<CliDeps["liveReload"]> {
  return {
    script,
    notify: () => undefined,
    notifyError: () => undefined,
    notifyStyleUpdate: () => undefined,
    notifyPageSwap: () => undefined,
    close: () => undefined,
  };
}

describe("run dev — in-preview AI overlay injection (ADR 0033 Inc 2)", () => {
  const sites: readonly Site[] = [{ name: "app", render: "dynamic", basePath: "/" }];

  // A config whose `/` answers with a string HTML doc and `/posts` with JSON, so both the
  // HTML-append and the non-HTML passthrough arms are exercised.
  function htmlConfig(): LestoAppConfig {
    return {
      db: adapt(database),
      app: lesto()
        .get("/", (c) => c.html("<html><head></head><body>hi</body></html>"))
        .get("/posts", (c) => c.json({ ok: true })),
      migrations,
    };
  }

  it("appends the AI overlay as a SECOND sibling <script>, after the live-reload one", async () => {
    const capture = capturingServe();

    await run(
      ["dev"],
      depsWith({
        serve: capture.serve,
        loadApp: () => Promise.resolve(htmlConfig()),
        loadSites: () => Promise.resolve(sites),
        liveReload: reloadSeam("RELOAD();"),
        aiOverlay: { script: "AIOVERLAY();", endpoint: "/__lesto_dev_ai", token: "dev-token" },
      }),
    );

    const html = await drainBody((await capture.app().handle("GET", "/")).body);

    // Both scripts ride the same append path, as two distinct trailing <script> tags…
    expect(html).toContain("<script>RELOAD();</script>");
    expect(html).toContain("<script>AIOVERLAY();</script>");
    // …with the AI overlay appended AFTER the reload script (a second sibling).
    expect(html.indexOf("AIOVERLAY();")).toBeGreaterThan(html.indexOf("RELOAD();"));
  });

  it("appends the AI overlay to a STREAMED html body too", async () => {
    const capture = capturingServe();

    await run(
      ["dev"],
      depsWith({
        serve: capture.serve,
        loadApp: () =>
          Promise.resolve({
            ...htmlConfig(),
            app: lesto().get("/stream", () => ({
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
              body: streamBody() as unknown as string,
            })),
          }),
        loadSites: () => Promise.resolve(sites),
        liveReload: reloadSeam("RELOAD();"),
        aiOverlay: { script: "AIOVERLAY();", endpoint: "/__lesto_dev_ai", token: "dev-token" },
      }),
    );

    const html = await drainBody((await capture.app().handle("GET", "/stream")).body);

    expect(html).toContain("streamed");
    expect(html).toContain("<script>RELOAD();</script>");
    expect(html).toContain("<script>AIOVERLAY();</script>");
  });

  it("injects the AI overlay independently of live reload (seam present, no live reload)", async () => {
    const capture = capturingServe();

    await run(
      ["dev"],
      depsWith({
        serve: capture.serve,
        loadApp: () => Promise.resolve(htmlConfig()),
        loadSites: () => Promise.resolve(sites),
        aiOverlay: { script: "AIOVERLAY();", endpoint: "/__lesto_dev_ai", token: "dev-token" },
      }),
    );

    const html = await drainBody((await capture.app().handle("GET", "/")).body);

    expect(html).toContain("<script>AIOVERLAY();</script>");
    expect(html).not.toContain("RELOAD();");
  });

  it("leaves a non-HTML (JSON) response untouched by the AI overlay", async () => {
    const capture = capturingServe();

    await run(
      ["dev"],
      depsWith({
        serve: capture.serve,
        loadApp: () => Promise.resolve(htmlConfig()),
        loadSites: () => Promise.resolve(sites),
        aiOverlay: { script: "AIOVERLAY();", endpoint: "/__lesto_dev_ai", token: "dev-token" },
      }),
    );

    const body = await drainBody((await capture.app().handle("GET", "/posts")).body);

    expect(body).not.toContain("AIOVERLAY();");
    expect(body).toContain("ok");
  });

  it("is dev-only: serve / build / deploy refuse the AI overlay seam (CLI_DEV_SURFACE_IN_PRODUCTION)", async () => {
    for (const command of ["serve", "build", "deploy"]) {
      await expect(
        run(
          [command],
          depsWith({
            aiOverlay: { script: "AIOVERLAY();", endpoint: "/__lesto_dev_ai", token: "dev-token" },
          }),
        ),
      ).rejects.toMatchObject({ code: "CLI_DEV_SURFACE_IN_PRODUCTION" });
    }
  });

  it("keeps the overlay BUILDER out of the covered core and adds no new runtime package import", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "run.ts"),
      "utf8",
    );

    // The core consumes only the pre-built `script` string via the seam — the builder
    // (`aiOverlayClientScript`) lives in the bin (dev-only) and is never CALLED here. Match
    // the call form (name + `(`), so the doc-comment prose that cites the builder by name
    // doesn't false-trip (the same idiom the mcp layering greps use).
    expect(source).not.toContain("aiOverlayClientScript(");
    // …and this feature pulls in no new runtime package (the seam carries a plain string).
    expect(source).not.toContain('from "@lesto/ai"');
    expect(source).not.toContain('from "@lesto/mcp"');
  });
});

describe("run dev — in-preview AI endpoint (ADR 0033 Inc 6a + L-69d76e71 hardening)", () => {
  const endpoint = "/__lesto_dev_ai";
  const script = "AIOVERLAY();";
  const token = "dev-token-".repeat(4); // 40 chars; length is irrelevant to the compare (a real minted token is 64 hex chars)
  const authed = {
    origin: "http://localhost:5173",
    host: "localhost:5173",
    "x-lesto-dev-token": token,
  };

  // Boot `runDev` with an AI overlay seam and hand back the outermost handle the server fronts —
  // the one `withAiEndpoint` wraps — so a test can POST a turn straight at it. The app is the
  // default `buildConfig` (its `GET /posts` / `POST /posts` routes stand in for pass-through).
  async function bootHandle(overlay: NonNullable<CliDeps["aiOverlay"]>): Promise<App> {
    const capture = capturingServe();
    await run(["dev"], depsWith({ serve: capture.serve, aiOverlay: overlay }));

    return capture.app();
  }

  /** Read a `{ reply }` JSON body back to its `reply` string. */
  async function replyOf(response: { body: unknown }): Promise<string> {
    return (JSON.parse(await drainBody(response.body)) as { reply: string }).reply;
  }

  it("round-trips a chat turn through a wired read-tool dispatch and reflects the result", async () => {
    const turns: AiTurn[] = [];
    const dispatchDevTool = (turn: AiTurn): Promise<unknown> => {
      turns.push(turn);

      return Promise.resolve({ collections: ["posts", "pages"] });
    };

    const served = await bootHandle({ script, endpoint, token, dispatchDevTool });
    const response = await served.handle("POST", endpoint, {
      headers: authed,
      body: { prompt: "what collections exist?", route: "/posts" },
    });

    expect(response.status).toBe(200);
    // The overlay runs the fixed inspect tool (`describe_app`, an allowlisted read-only contract
    // tool), the assembled + redacted route flows through as its input, and the read-only result
    // is reflected back into the reply.
    expect(turns.map((turn) => turn.tool)).toEqual(["describe_app"]);
    expect(turns[0]?.input?.route).toBe("/posts");
    const reply = await replyOf(response);
    expect(reply).toContain("what collections exist?");
    expect(reply).toContain("posts");
  });

  it("scrubs a secret in the tool RESULT before it hits the reply, keeping routes intact (L-01d526da)", async () => {
    // The Stripe key is assembled at runtime so the contiguous literal never appears in
    // source — GitHub push protection scans the raw file (L-b58f9bc0); value is unchanged.
    const stripeLivePrefix = ["sk_live", "_"].join("");
    const stripeSecret = `${stripeLivePrefix}51H8xYz0123456789abcdEFGH`;
    const served = await bootHandle({
      script,
      endpoint,
      token,
      // A future data-bearing read tool could echo a secret AND a route; the result is redacted
      // structure-aware — the secret is stripped, the long multi-segment route is preserved.
      dispatchDevTool: () =>
        Promise.resolve({
          routes: ["/api/v2/organizations/settings"],
          note: `deployed with ${stripeSecret}`,
        }),
    });

    const response = await served.handle("POST", endpoint, {
      headers: authed,
      body: { prompt: "inspect", route: "/" },
    });

    const reply = await replyOf(response);
    expect(reply).not.toContain(stripeLivePrefix);
    expect(reply).toContain("<redacted>");
    expect(reply).toContain("/api/v2/organizations/settings");
  });

  it("redacts a secret pasted into the prompt before it can leave the process (L-7fd1b91e)", async () => {
    // Assembled at runtime so the contiguous AWS key literal never appears in source —
    // GitHub push protection scans the raw file (L-b58f9bc0); value is unchanged.
    const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const served = await bootHandle({
      script,
      endpoint,
      token,
      dispatchDevTool: () => Promise.resolve({ ok: true }),
    });

    const response = await served.handle("POST", endpoint, {
      headers: authed,
      body: { prompt: `my key ${awsKey} ok?`, route: "/" },
    });

    const reply = await replyOf(response);
    expect(reply).not.toContain(awsKey);
    expect(reply).toContain("<redacted>");
  });

  it("defaults an absent route to an empty context but still dispatches a valid turn", async () => {
    const turns: AiTurn[] = [];
    const served = await bootHandle({
      script,
      endpoint,
      token,
      dispatchDevTool: (turn) => {
        turns.push(turn);

        return Promise.resolve({});
      },
    });

    const response = await served.handle("POST", endpoint, {
      headers: authed,
      body: { prompt: "hello" },
    });

    expect(response.status).toBe(200);
    expect(turns).toHaveLength(1);
  });

  it("never throws on a non-serializable tool result — renders a placeholder instead of a 500", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const served = await bootHandle({
      script,
      endpoint,
      token,
      dispatchDevTool: () => Promise.resolve(circular),
    });

    const response = await served.handle("POST", endpoint, {
      headers: authed,
      body: { prompt: "x", route: "/" },
    });

    expect(response.status).toBe(200);
    expect(await replyOf(response)).toContain("(unserializable result)");
  });

  it("fails closed to the inspect-only 'not available' reply when no dispatch seam is wired", async () => {
    const served = await bootHandle({ script, endpoint, token });

    const response = await served.handle("POST", endpoint, {
      headers: authed,
      body: { prompt: "why is /posts a 404?", route: "/posts" },
    });

    expect(response.status).toBe(200);
    expect(await replyOf(response)).toContain("not available");
  });

  it("rejects a body without a string prompt as a 400", async () => {
    const served = await bootHandle({ script, endpoint, token });

    for (const body of [{ route: "/" }, "not-json", { prompt: 42 }, null]) {
      const response = await served.handle("POST", endpoint, { headers: authed, body });

      expect(response.status).toBe(400);
    }
  });

  it("requires the per-session dev token — absent, wrong-length, and wrong all refuse (403)", async () => {
    const dispatchDevTool = vi.fn((): Promise<unknown> => Promise.resolve({}));
    const served = await bootHandle({ script, endpoint, token, dispatchDevTool });
    const body = { prompt: "x", route: "/" };
    const originHost = { origin: "http://localhost:5173", host: "localhost:5173" };

    // Absent token header: same-origin passes, the token gate refuses.
    const noToken = await served.handle("POST", endpoint, { headers: originHost, body });
    expect(noToken.status).toBe(403);

    // Wrong length: fails the length guard before `timingSafeEqual` is ever called.
    const shortToken = await served.handle("POST", endpoint, {
      headers: { ...originHost, "x-lesto-dev-token": "short" },
      body,
    });
    expect(shortToken.status).toBe(403);

    // Right length, wrong value: fails the constant-time compare.
    const wrongToken = await served.handle("POST", endpoint, {
      headers: { ...originHost, "x-lesto-dev-token": "z".repeat(token.length) },
      body,
    });
    expect(wrongToken.status).toBe(403);

    expect(dispatchDevTool).not.toHaveBeenCalled();
  });

  it("refuses a cross-site, cross-scheme, or cross-port Origin before the token check or dispatch", async () => {
    const dispatchDevTool = vi.fn((): Promise<unknown> => Promise.resolve({}));
    const served = await bootHandle({ script, endpoint, token, dispatchDevTool });
    const body = { prompt: "exfiltrate", route: "/" };

    // Cross-site host, even with a valid token — same-origin runs first.
    const crossSite = await served.handle("POST", endpoint, {
      headers: {
        origin: "https://evil.example",
        host: "localhost:5173",
        "x-lesto-dev-token": token,
      },
      body,
    });
    expect(crossSite.status).toBe(403);

    // Same host:port but https — a cross-scheme Origin is not the app's own http page.
    const crossScheme = await served.handle("POST", endpoint, {
      headers: {
        origin: "https://localhost:5173",
        host: "localhost:5173",
        "x-lesto-dev-token": token,
      },
      body,
    });
    expect(crossScheme.status).toBe(403);

    // Same http scheme, different port — host mismatch (a co-resident app on another port).
    const otherPort = await served.handle("POST", endpoint, {
      headers: {
        origin: "http://localhost:9999",
        host: "localhost:5173",
        "x-lesto-dev-token": token,
      },
      body,
    });
    expect(otherPort.status).toBe(403);

    expect(dispatchDevTool).not.toHaveBeenCalled();
  });

  it("refuses a missing Origin, a missing Host, an unparseable Origin, and a headerless request", async () => {
    const served = await bootHandle({ script, endpoint, token });
    const body = { prompt: "x", route: "/" };

    const missingOrigin = await served.handle("POST", endpoint, {
      headers: { host: "localhost:5173", "x-lesto-dev-token": token },
      body,
    });
    expect(missingOrigin.status).toBe(403);

    const missingHost = await served.handle("POST", endpoint, {
      headers: { origin: "http://localhost:5173", "x-lesto-dev-token": token },
      body,
    });
    expect(missingHost.status).toBe(403);

    const badOrigin = await served.handle("POST", endpoint, {
      headers: { origin: "::not-a-url::", host: "localhost:5173", "x-lesto-dev-token": token },
      body,
    });
    expect(badOrigin.status).toBe(403);

    // No options at all — the `options?.headers` / `options?.body` absent path.
    const noOptions = await served.handle("POST", endpoint);
    expect(noOptions.status).toBe(403);
  });

  it("passes a non-endpoint request straight through to the app (GET and POST)", async () => {
    const served = await bootHandle({ script, endpoint, token });

    const get = await served.handle("GET", "/posts", { headers: authed });
    expect(get.status).toBe(200);
    expect(await drainBody(get.body)).toContain("posts");

    const post = await served.handle("POST", "/posts", {
      headers: authed,
      body: { title: "hi" },
    });
    expect(post.status).toBe(201);
  });

  it("propagates a non-fail-closed dispatch error instead of masking it as unavailable", async () => {
    const served = await bootHandle({
      script,
      endpoint,
      token,
      dispatchDevTool: () => Promise.reject(new Error("boom")),
    });

    await expect(
      served.handle("POST", endpoint, { headers: authed, body: { prompt: "x", route: "/" } }),
    ).rejects.toThrow("boom");
  });

  it("propagates a CliError of a DIFFERENT code (branch on the code, not the type)", async () => {
    const served = await bootHandle({
      script,
      endpoint,
      token,
      dispatchDevTool: () => Promise.reject(new CliError("CLI_UNKNOWN_COMMAND", "nope")),
    });

    await expect(
      served.handle("POST", endpoint, { headers: authed, body: { prompt: "x", route: "/" } }),
    ).rejects.toBeInstanceOf(CliError);
  });
});

describe("run deploy", () => {
  // Two zones: a static marketing root (two pages) and a dynamic mls app. Both
  // marketing routes map to posts#index so they render 200 and ship as 2 routes.
  const sites: readonly Site[] = [
    { name: "marketing", render: "static", basePath: "/", pages: ["/posts", "/more"] },
    { name: "mls", render: "dynamic", basePath: "/mls" },
  ];

  function twoRouteConfig(): LestoAppConfig {
    const app = lesto()
      .get("/posts", (c) => c.json({ posts: [] }))
      .get("/more", (c) => c.json({ posts: [] }));

    return {
      db: adapt(database),
      app,
      migrations,
    };
  }

  const loadApp = (): Promise<LestoAppConfig> => Promise.resolve(twoRouteConfig());

  it("builds, ships the static target into --dist, and prints the routing plan", async () => {
    const { sink } = recordingSink();
    const { uploader, shipped, distDirs } = recordingUploader();

    const code = await run(
      ["deploy", "--dist", "build-out"],
      depsWith({ loadApp, loadSites: () => Promise.resolve(sites), sink, uploader }),
    );

    expect(code).toBe(0);

    // The uploader was rooted at the --dist value, and both static pages shipped.
    expect(distDirs).toEqual(["build-out"]);
    expect(shipped.size).toBe(2);

    // Output: the static ship (plural routes), the dynamic run hint, and the
    // routing manifest — most-specific prefix first, so an edge sends /mls/* to
    // node, else the CDN.
    expect(lines).toEqual([
      "shipped marketing: 2 routes",
      "mls: run `lesto serve` (dynamic)",
      "route /mls → dynamic",
      "route / → static",
    ]);
  });

  it("with --target, deploys only the named site", async () => {
    const { sink } = recordingSink();
    const { uploader, shipped } = recordingUploader();

    // A single-page marketing site (default app routes "/posts") — ships one
    // route, exercising the singular noun against the plural case above.
    const oneSite: readonly Site[] = [
      { name: "marketing", render: "static", basePath: "/", pages: ["/posts"] },
    ];

    const code = await run(
      ["deploy", "--target", "marketing"],
      depsWith({ loadSites: () => Promise.resolve(oneSite), sink, uploader }),
    );

    expect(code).toBe(0);
    expect(shipped.size).toBe(1);
    expect(lines).toEqual(["shipped marketing: 1 route", "route / → static"]);
  });

  it("refuses an unknown --target", async () => {
    await expect(
      run(["deploy", "--target", "ghost"], depsWith({ loadSites: () => Promise.resolve(sites) })),
    ).rejects.toMatchObject({ code: "CLI_UNKNOWN_TARGET" });
  });

  it("an all-dynamic plan ships nothing static — points at --cloudflare / serve, not a silent no-op", async () => {
    const { sink } = recordingSink();
    const { uploader, shipped } = recordingUploader();

    // The freshly scaffolded shape: one dynamic zone at the root, no static sites.
    // The default deploy has nothing to upload, so it must NAME the live-tier paths
    // rather than print only "run `lesto serve`" and look like it did nothing.
    const dynamicOnly: readonly Site[] = [{ name: "app", render: "dynamic", basePath: "/" }];

    const code = await run(
      ["deploy"],
      depsWith({ loadApp, loadSites: () => Promise.resolve(dynamicOnly), sink, uploader }),
    );

    expect(code).toBe(0);
    // Nothing was uploaded by the copy shipper.
    expect(shipped.size).toBe(0);
    expect(lines).toEqual([
      "app: run `lesto serve` (dynamic)",
      "route / → dynamic",
      "no static routes to ship — deploy the live app with `lesto deploy --cloudflare` " +
        "(Worker + assets via wrangler) or self-host it with `lesto serve`",
    ]);
  });

  it("--release stages an immutable versioned tree and flips the pointer", async () => {
    const { sink } = recordingSink();
    const { store, shipped, pointer } = memoryReleaseStore();
    const targets: ReleaseTarget[] = [];

    const code = await run(
      ["deploy", "--release", "--version", "v7", "--dist", "blue-green"],
      depsWith({
        loadApp,
        loadSites: () => Promise.resolve(sites),
        sink,
        releaseStore: (target) => {
          targets.push(target);

          return store;
        },
      }),
    );

    expect(code).toBe(0);
    // No bucket/endpoint flags → the local on-disk store, rooted at --dist.
    expect(targets).toEqual([{ kind: "local", distDir: "blue-green" }]);

    // Every file landed under the release's immutable prefix, never in place.
    expect([...shipped.keys()].every((key) => key.startsWith("releases/v7/"))).toBe(true);
    expect(shipped.size).toBe(2);
    expect(pointer.current).toBe("v7");

    expect(lines).toEqual([
      "released marketing: 2 routes (version v7)",
      "mls: run `lesto serve` (dynamic)",
      "current → v7",
      "route /mls → dynamic",
      "route / → static",
    ]);
  });

  it("--release stamps a version from the injected clock when none is given", async () => {
    const { sink } = recordingSink();
    const { store, pointer } = memoryReleaseStore();

    // 2026-06-11T00:00:00.000Z, made path-segment safe.
    const code = await run(
      ["deploy", "--release"],
      depsWith({
        loadApp,
        loadSites: () => Promise.resolve(sites),
        sink,
        releaseStore: () => store,
        now: () => Date.UTC(2026, 5, 11),
      }),
    );

    expect(code).toBe(0);
    expect(pointer.current).toBe("2026-06-11T00-00-00-000Z");
    expect(lines).toContain("current → 2026-06-11T00-00-00-000Z");
  });

  it("--release with --bucket/--endpoint builds a remote S3/R2 release target", async () => {
    const { sink } = recordingSink();
    const { store, shipped, pointer } = memoryReleaseStore();
    const targets: ReleaseTarget[] = [];

    const code = await run(
      [
        "deploy",
        "--release",
        "--version",
        "v1",
        "--bucket",
        "site",
        "--endpoint",
        "https://acct.r2.cloudflarestorage.com",
        "--region",
        "us-east-1",
        "--pointer",
        "sites/marketing/current",
      ],
      depsWith({
        loadApp,
        loadSites: () => Promise.resolve(sites),
        sink,
        releaseStore: (target) => {
          targets.push(target);

          return store;
        },
      }),
    );

    expect(code).toBe(0);
    // The flags resolve to the remote target; credentials are NOT among them.
    expect(targets).toEqual([
      {
        kind: "remote",
        endpoint: "https://acct.r2.cloudflarestorage.com",
        bucket: "site",
        region: "us-east-1",
        pointerKey: "sites/marketing/current",
      },
    ]);

    // The versioned release machinery is unchanged on the remote target: both
    // files staged under the immutable prefix, then the pointer flipped.
    expect(shipped.size).toBe(2);
    expect([...shipped.keys()].every((key) => key.startsWith("releases/v1/"))).toBe(true);
    expect(pointer.current).toBe("v1");
  });

  it("--release defaults a remote region to auto (R2) and omits an unset pointer", async () => {
    const { sink } = recordingSink();
    const { store } = memoryReleaseStore();
    let target: ReleaseTarget | undefined;

    const code = await run(
      [
        "deploy",
        "--release",
        "--version",
        "v1",
        "--bucket",
        "site",
        "--endpoint",
        "https://acct.r2.cloudflarestorage.com",
      ],
      depsWith({
        loadApp,
        loadSites: () => Promise.resolve(sites),
        sink,
        releaseStore: (t) => {
          target = t;

          return store;
        },
      }),
    );

    expect(code).toBe(0);
    expect(target).toEqual({
      kind: "remote",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "site",
      region: "auto",
    });
  });

  it("treats --bucket/--endpoint as a release even without --release (no silent local copy)", async () => {
    const { sink } = recordingSink();
    const { store, shipped } = memoryReleaseStore();
    let target: ReleaseTarget | undefined;

    // No --release flag: naming a remote bucket must still take the release path,
    // never fall through to a local in-place copy that drops the remote flags.
    const code = await run(
      [
        "deploy",
        "--version",
        "v1",
        "--bucket",
        "site",
        "--endpoint",
        "https://acct.r2.cloudflarestorage.com",
      ],
      depsWith({
        loadApp,
        loadSites: () => Promise.resolve(sites),
        sink,
        releaseStore: (t) => {
          target = t;

          return store;
        },
      }),
    );

    expect(code).toBe(0);
    expect(target).toEqual({
      kind: "remote",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "site",
      region: "auto",
    });
    // It really shipped a release (the two marketing pages staged under the
    // immutable prefix), not a copy — asserting the count so the prefix check
    // cannot pass vacuously on an empty ship.
    expect(shipped.size).toBe(2);
    expect([...shipped.keys()].every((key) => key.startsWith("releases/v1/"))).toBe(true);
  });

  it("--release refuses a --bucket with no --endpoint (CLI_DEPLOY_INCOMPLETE_REMOTE)", async () => {
    const { sink } = recordingSink();

    await expect(
      run(
        ["deploy", "--release", "--bucket", "site"],
        depsWith({ loadApp, loadSites: () => Promise.resolve(sites), sink }),
      ),
    ).rejects.toMatchObject({
      code: "CLI_DEPLOY_INCOMPLETE_REMOTE",
      details: { bucket: "site", endpoint: undefined },
    });
  });

  it("refuses an --endpoint with no --bucket (CLI_DEPLOY_INCOMPLETE_REMOTE)", async () => {
    const { sink } = recordingSink();

    // No --release either: the endpoint alone implies a remote release, so the
    // incomplete-pair guard still fires (and reports the captured, non-secret flags).
    await expect(
      run(
        ["deploy", "--endpoint", "https://acct.r2.cloudflarestorage.com"],
        depsWith({ loadApp, loadSites: () => Promise.resolve(sites), sink }),
      ),
    ).rejects.toMatchObject({
      code: "CLI_DEPLOY_INCOMPLETE_REMOTE",
      details: { bucket: undefined, endpoint: "https://acct.r2.cloudflarestorage.com" },
    });
  });

  it("--cloudflare deploys the Worker and health-checks the URL it reported", async () => {
    const { sink } = recordingSink();
    const deploy = vi.fn(() => Promise.resolve({ url: "https://estate.workers.dev" }));
    const rollback = vi.fn(() => Promise.resolve());
    const checked: string[] = [];

    const code = await run(
      ["deploy", "--cloudflare"],
      depsWith({
        loadApp,
        loadSites: () => Promise.resolve(sites),
        sink,
        cloudflare: { deploy, rollback },
        checkHealth: (url) => {
          checked.push(url);

          return Promise.resolve(true);
        },
      }),
    );

    expect(code).toBe(0);
    expect(deploy).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    // Probed the reported URL's /readyz; no separate static ship on this path.
    expect(checked).toEqual(["https://estate.workers.dev/readyz"]);
    expect(lines).toEqual([
      "deployed → https://estate.workers.dev",
      "health check passed: https://estate.workers.dev/readyz",
    ]);
  });

  it("--cloudflare bundles the island client into out/ before deploying", async () => {
    const built: Array<{ outDir: string; mode: string; dialect: string }> = [];
    const deploy = vi.fn(() => Promise.resolve({ url: undefined }));

    const code = await run(
      ["deploy", "--cloudflare"],
      depsWith({
        loadApp,
        loadSites: () => Promise.resolve(sites),
        sink: recordingSink().sink,
        cloudflare: { deploy, rollback: vi.fn() },
        hasIslandsDir: () => Promise.resolve(true),
        buildClientAssets: (options) => {
          built.push(options);

          return Promise.resolve();
        },
      }),
    );

    expect(code).toBe(0);
    // /client.js + chunks must land in out/ so the deployed Worker's island
    // hydrates — the documented one-command deploy must not ship a dead island.
    expect(built).toEqual([{ outDir: "out", mode: "production", dialect: "react" }]);
    expect(deploy).toHaveBeenCalledOnce();
  });

  it("--cloudflare rolls the Worker back and refuses when the health check fails", async () => {
    const { sink } = recordingSink();
    const rollback = vi.fn(() => Promise.resolve());

    await expect(
      run(
        ["deploy", "--cloudflare"],
        depsWith({
          loadApp,
          loadSites: () => Promise.resolve(sites),
          sink,
          cloudflare: {
            deploy: () => Promise.resolve({ url: "https://estate.workers.dev" }),
            rollback,
          },
          checkHealth: () => Promise.resolve(false),
        }),
      ),
    ).rejects.toMatchObject({ code: "CLI_DEPLOY_UNHEALTHY" });

    // The broken release was rolled back rather than left live.
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("--cloudflare skips the health gate (out loud) when the driver reports no URL", async () => {
    const { sink } = recordingSink();
    const checkHealth = vi.fn(() => Promise.resolve(true));

    const code = await run(
      ["deploy", "--cloudflare"],
      depsWith({
        loadApp,
        loadSites: () => Promise.resolve(sites),
        sink,
        cloudflare: { deploy: () => Promise.resolve({ url: undefined }), rollback: vi.fn() },
        checkHealth,
      }),
    );

    expect(code).toBe(0);
    expect(checkHealth).not.toHaveBeenCalled();
    expect(lines).toEqual([
      "deployed the Worker",
      "health check skipped — no URL to probe (pass --health-url to gate the deploy)",
    ]);
  });

  it("--cloudflare health-checks an explicit --health-url instead of the reported one", async () => {
    const { sink } = recordingSink();
    const checked: string[] = [];

    const code = await run(
      ["deploy", "--cloudflare", "--health-url", "https://estate.example.com/healthz"],
      depsWith({
        loadApp,
        loadSites: () => Promise.resolve(sites),
        sink,
        cloudflare: {
          deploy: () => Promise.resolve({ url: "https://estate.workers.dev" }),
          rollback: vi.fn(),
        },
        checkHealth: (url) => {
          checked.push(url);

          return Promise.resolve(true);
        },
      }),
    );

    expect(code).toBe(0);
    expect(checked).toEqual(["https://estate.example.com/healthz"]);
    expect(lines).toContain("health check passed: https://estate.example.com/healthz");
  });
});

describe("run rollback", () => {
  it("flips the pointer back to a published release and reports the move", async () => {
    const { store, pointer } = memoryReleaseStore();
    const targets: ReleaseTarget[] = [];

    await store.put("releases/v1/marketing/index.html", "old", "text/html");
    await store.setCurrent("v2");

    const code = await run(
      ["rollback", "--to", "v1", "--dist", "blue-green"],
      depsWith({
        releaseStore: (target) => {
          targets.push(target);

          return store;
        },
      }),
    );

    expect(code).toBe(0);
    expect(targets).toEqual([{ kind: "local", distDir: "blue-green" }]);
    expect(pointer.current).toBe("v1");
    expect(lines).toEqual(["rolled back: v2 → v1"]);
  });

  it("says 'now serving' when nothing was live before the flip", async () => {
    const { store } = memoryReleaseStore();

    await store.put("releases/v1/marketing/index.html", "old", "text/html");

    const code = await run(["rollback", "--to", "v1"], depsWith({ releaseStore: () => store }));

    expect(code).toBe(0);
    expect(lines).toEqual(["now serving v1"]);
  });

  it("rolls back against a remote S3/R2 store named by --bucket/--endpoint", async () => {
    const { store, pointer } = memoryReleaseStore();
    let target: ReleaseTarget | undefined;

    await store.put("releases/v1/marketing/index.html", "old", "text/html");
    await store.setCurrent("v2");

    const code = await run(
      [
        "rollback",
        "--to",
        "v1",
        "--bucket",
        "site",
        "--endpoint",
        "https://acct.r2.cloudflarestorage.com",
      ],
      depsWith({
        releaseStore: (t) => {
          target = t;

          return store;
        },
      }),
    );

    expect(code).toBe(0);
    // Rollback resolves the same remote target deploy --release does (shared helper).
    expect(target).toEqual({
      kind: "remote",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "site",
      region: "auto",
    });
    expect(pointer.current).toBe("v1");
    expect(lines).toEqual(["rolled back: v2 → v1"]);
  });

  it("refuses to run without --to (no guessing under pressure)", async () => {
    await expect(run(["rollback"], depsWith())).rejects.toMatchObject({
      code: "CLI_ROLLBACK_MISSING_VERSION",
    });
  });

  it("surfaces the store's refusal of an unpublished version", async () => {
    const { store } = memoryReleaseStore();

    await expect(
      run(["rollback", "--to", "ghost"], depsWith({ releaseStore: () => store })),
    ).rejects.toMatchObject({ code: "DEPLOY_UNKNOWN_RELEASE" });
  });
});

describe("run help", () => {
  it("prints usage and returns 0", async () => {
    const code = await run(["help"], depsWith());

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("lesto — the Lesto command-line tool");
    expect(lines[0]).toContain("routes");
    expect(lines[0]).toContain("deploy");
  });

  it("prints usage for an empty command", async () => {
    const code = await run([], depsWith());

    expect(code).toBe(0);
    expect(lines[0]).toContain("Usage: lesto <command>");
  });

  it("prints usage for an empty-string command", async () => {
    const code = await run([""], depsWith());

    expect(code).toBe(0);
    expect(lines[0]).toContain("Usage: lesto <command>");
  });
});

describe("run unknown", () => {
  it("throws CliError CLI_UNKNOWN_COMMAND", async () => {
    await expect(run(["bogus"], depsWith())).rejects.toMatchObject({
      code: "CLI_UNKNOWN_COMMAND",
    });

    try {
      await run(["bogus"], depsWith());
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).details).toEqual({ command: "bogus" });
    }
  });
});

describe("run content:build", () => {
  it("persists the pipeline's entries into the content store and reports the count", async () => {
    // `persistEntries` is an injected seam now (the optional content-store peer is
    // dynamic-imported by the bin). Hand the build its entries and a fake persister
    // that echoes the count, and assert the command reports what it persisted.
    const entries = [
      entry("posts", "hello", { title: "Hello" }),
      entry("posts", "world", { title: "World" }),
    ];

    const persisted: RuntimeEntry[][] = [];

    const code = await run(
      ["content:build"],
      depsWith({
        buildContent: () => Promise.resolve(entries),
        persistEntries: (_db, given) => {
          persisted.push([...given]);

          return Promise.resolve({ persisted: given.length });
        },
      }),
    );

    expect(code).toBe(0);
    expect(lines).toEqual(["built 2 entries into the content store"]);

    // The build handed the pipeline's entries straight to the persister.
    expect(persisted).toEqual([entries]);
  });

  it("says 'entry' (singular) for a single built entry", async () => {
    const code = await run(
      ["content:build"],
      depsWith({
        buildContent: () => Promise.resolve([entry("posts", "solo", { title: "Solo" })]),
        persistEntries: (_db, given) => Promise.resolve({ persisted: given.length }),
      }),
    );

    expect(code).toBe(0);
    expect(lines).toEqual(["built 1 entry into the content store"]);
  });

  it("with --prune, drops entries the build no longer produces", async () => {
    // The build produces one entry; --prune reports the stale rows the injected
    // pruner removed. The pruner is faked to return one deletion, exercising the
    // singular "stale entry" noun and the prune line.
    const code = await run(
      ["content:build", "--prune"],
      depsWith({
        buildContent: () => Promise.resolve([entry("posts", "keep", {})]),
        persistEntries: (_db, given) => Promise.resolve({ persisted: given.length }),
        pruneEntries: (_db, _keep) => Promise.resolve({ deleted: 1 }),
      }),
    );

    expect(code).toBe(0);
    expect(lines).toEqual(["built 1 entry into the content store", "pruned 1 stale entry"]);
  });

  it("does not prune without the --prune flag", async () => {
    const pruneEntries = vi.fn(() => Promise.resolve({ deleted: 0 }));

    const code = await run(
      ["content:build"],
      depsWith({
        buildContent: () => Promise.resolve([entry("posts", "keep", {})]),
        pruneEntries,
      }),
    );

    expect(code).toBe(0);
    expect(pruneEntries).not.toHaveBeenCalled();
    expect(lines).toEqual(["built 1 entry into the content store"]);
  });
});

describe("run content:new", () => {
  it("scaffolds an entry and reports it", async () => {
    const createEntry = vi.fn(() => Promise.resolve());

    const code = await run(
      ["content:new", "posts", "My", "First", "Post"],
      depsWith({ createEntry }),
    );

    expect(code).toBe(0);
    expect(createEntry).toHaveBeenCalledWith("posts", "My First Post");
    expect(lines).toEqual(["created posts entry: My First Post"]);
  });

  it("throws CLI_CONTENT_MISSING_ARGS when the title is absent", async () => {
    await expect(run(["content:new", "posts"], depsWith())).rejects.toMatchObject({
      code: "CLI_CONTENT_MISSING_ARGS",
    });
  });

  it("throws CLI_CONTENT_MISSING_ARGS when the collection is absent", async () => {
    try {
      await run(["content:new"], depsWith());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("CLI_CONTENT_MISSING_ARGS");
    }
  });
});

describe("run content:delete", () => {
  it("deletes an existing entry and reports it", async () => {
    // `deleteEntry` is injected: a fake that reports one row removed stands in for
    // the content-store call (a hit), so the command prints the "deleted" line.
    const deleteEntry = vi.fn(() => Promise.resolve({ deleted: 1 }));

    const code = await run(["content:delete", "posts", "doomed"], depsWith({ deleteEntry }));

    expect(code).toBe(0);
    expect(deleteEntry).toHaveBeenCalledWith(expect.anything(), "posts", "doomed");
    expect(lines).toEqual(["deleted posts entry: doomed"]);
  });

  it("reports when there was nothing to delete", async () => {
    // A miss: the injected deleter reports zero rows removed, so the command takes
    // the "no entry" branch.
    const code = await run(
      ["content:delete", "posts", "ghost"],
      depsWith({ deleteEntry: vi.fn(() => Promise.resolve({ deleted: 0 })) }),
    );

    expect(code).toBe(0);
    expect(lines).toEqual(["no posts entry: ghost"]);
  });

  it("throws CLI_CONTENT_MISSING_ARGS when the collection is absent", async () => {
    await expect(run(["content:delete"], depsWith())).rejects.toMatchObject({
      code: "CLI_CONTENT_MISSING_ARGS",
    });
  });

  it("throws CLI_CONTENT_MISSING_ARGS when the slug is absent", async () => {
    await expect(run(["content:delete", "posts"], depsWith())).rejects.toMatchObject({
      code: "CLI_CONTENT_MISSING_ARGS",
    });
  });
});

describe("parsePort", () => {
  it("reads the value after --port", () => {
    expect(parsePort(["--port", "9090"], 3000)).toEqual({ port: 9090 });
  });

  it("falls back when the flag is absent", () => {
    expect(parsePort(["--other", "x"], 3000)).toEqual({ port: 3000 });
  });

  it("falls back when --port has no value", () => {
    expect(parsePort(["--port"], 3000)).toEqual({ port: 3000 });
  });

  it("falls back when the value is not a number", () => {
    expect(parsePort(["--port", "abc"], 3000)).toEqual({ port: 3000 });
  });
});

describe("parseStringFlag", () => {
  it("reads the token after the flag", () => {
    expect(parseStringFlag(["--target", "docs"], "target")).toBe("docs");
  });

  it("is undefined when the flag is absent", () => {
    expect(parseStringFlag(["--out", "dist"], "target")).toBeUndefined();
  });

  it("is undefined when the flag is the last token", () => {
    expect(parseStringFlag(["--target"], "target")).toBeUndefined();
  });

  it("does NOT consume a following flag as the value", () => {
    // `lesto build --out --target blog` means `--out` was given no value; the
    // parser must not swallow the next flag (`--target`) as `--out`'s value, or a
    // value-less `--out` would silently become `"--target"` and never write a dir.
    expect(parseStringFlag(["--out", "--target", "blog"], "out")).toBeUndefined();
  });

  it("does NOT consume a following flag even when that flag is the last token", () => {
    // The guard fires on the `--` prefix, not on there being a token after it.
    expect(parseStringFlag(["--target", "--out"], "target")).toBeUndefined();
  });
});

// --- Task 2: operator-tunable DoS limits, read from the environment ---

describe("parseServeLimit", () => {
  it("parses a clean positive integer", () => {
    expect(parseServeLimit("2048")).toBe(2048);
  });

  it("truncates a fractional value to an integer", () => {
    // A byte/ms count is integral; a stray decimal is floored, never handed on as
    // a fraction.
    expect(parseServeLimit("1500.9")).toBe(1500);
  });

  it("is undefined when unset, so serve's secure default applies", () => {
    expect(parseServeLimit(undefined)).toBeUndefined();
  });

  it("is undefined for a non-numeric value (never weakens the default)", () => {
    expect(parseServeLimit("16kib")).toBeUndefined();
  });

  it("is undefined for the empty string", () => {
    // `Number("")` is 0 — caught by the `<= 0` guard, not silently passed as a
    // zero limit that would disable the defense.
    expect(parseServeLimit("")).toBeUndefined();
  });

  it("is undefined for zero — a zero limit would disable the defense", () => {
    expect(parseServeLimit("0")).toBeUndefined();
  });

  it("is undefined for a negative value", () => {
    expect(parseServeLimit("-1")).toBeUndefined();
  });
});

describe("run serve threads the DoS limits from the environment", () => {
  it("passes every LESTO_* limit through to serve when set to valid values", async () => {
    const serve = fakeServe(3000);

    await run(
      ["serve"],
      depsWith({
        serve,
        env: {
          LESTO_MAX_BODY_BYTES: "2097152",
          LESTO_MAX_JSON_BODY_BYTES: "262144",
          LESTO_HANDLER_TIMEOUT_MS: "45000",
          LESTO_REQUEST_TIMEOUT_MS: "20000",
          LESTO_HEADERS_TIMEOUT_MS: "10000",
          LESTO_KEEP_ALIVE_TIMEOUT_MS: "3000",
          LESTO_MAX_HEADER_BYTES: "8192",
          LESTO_DRAIN_TIMEOUT_MS: "15000",
          LESTO_MAX_CONNECTIONS: "5000",
          LESTO_MAX_IN_FLIGHT_REQUESTS: "500",
        },
      }),
    );

    const [, options] = serve.mock.calls[0]!;

    expect(options?.maxBodyBytes).toBe(2097152);
    expect(options?.maxJsonBodyBytes).toBe(262144);
    expect(options?.handlerTimeoutMs).toBe(45000);
    expect(options?.requestTimeoutMs).toBe(20000);
    expect(options?.headersTimeoutMs).toBe(10000);
    expect(options?.keepAliveTimeoutMs).toBe(3000);
    expect(options?.maxHeaderBytes).toBe(8192);
    expect(options?.drainTimeoutMs).toBe(15000);
    expect(options?.maxConnections).toBe(5000);
    expect(options?.maxInFlightRequests).toBe(500);
  });

  it("leaves every limit unset (serve's secure defaults apply) when the env is empty", async () => {
    const serve = fakeServe(3000);

    await run(["serve"], depsWith({ serve, env: {} }));

    const [, options] = serve.mock.calls[0]!;

    // Absent from the options entirely — so `serve` falls through to its own
    // secure defaults (1 MiB body, 30s handler, etc.) rather than a weakened one.
    expect(options?.maxBodyBytes).toBeUndefined();
    expect(options?.maxJsonBodyBytes).toBeUndefined();
    expect(options?.handlerTimeoutMs).toBeUndefined();
    expect(options?.requestTimeoutMs).toBeUndefined();
    expect(options?.headersTimeoutMs).toBeUndefined();
    expect(options?.keepAliveTimeoutMs).toBeUndefined();
    expect(options?.maxHeaderBytes).toBeUndefined();
    expect(options?.drainTimeoutMs).toBeUndefined();
    expect(options?.maxConnections).toBeUndefined();
    expect(options?.maxInFlightRequests).toBeUndefined();
  });

  it("ignores an invalid limit (≤0 or non-numeric) and keeps the secure default for it", async () => {
    const serve = fakeServe(3000);

    await run(
      ["serve"],
      depsWith({
        serve,
        // A zero body limit and a junk header limit must both fall through; only
        // the valid handler timeout overrides its default.
        env: {
          LESTO_MAX_BODY_BYTES: "0",
          LESTO_MAX_HEADER_BYTES: "lots",
          LESTO_HANDLER_TIMEOUT_MS: "60000",
        },
      }),
    );

    const [, options] = serve.mock.calls[0]!;

    expect(options?.maxBodyBytes).toBeUndefined();
    expect(options?.maxHeaderBytes).toBeUndefined();
    expect(options?.handlerTimeoutMs).toBe(60000);
  });

  it("threads the same limits through `dev` too (parity with serve)", async () => {
    const serve = fakeServe(5173);

    await run(
      ["dev"],
      depsWith({
        serve,
        env: { LESTO_MAX_BODY_BYTES: "2097152", LESTO_HANDLER_TIMEOUT_MS: "45000" },
      }),
    );

    const [, options] = serve.mock.calls[0]!;

    expect(options?.maxBodyBytes).toBe(2097152);
    expect(options?.handlerTimeoutMs).toBe(45000);
  });
});

describe("declaresIslandDevPeer — the island Fast-Refresh opt-in gate", () => {
  it("is false when the package.json is not an object", () => {
    expect(declaresIslandDevPeer(null)).toBe(false);
    expect(declaresIslandDevPeer("not-an-object")).toBe(false);
  });

  it("is true when @lesto/island-dev is a dependency", () => {
    expect(declaresIslandDevPeer({ dependencies: { "@lesto/island-dev": "workspace:*" } })).toBe(
      true,
    );
  });

  it("is true when @lesto/island-dev is only a devDependency", () => {
    expect(declaresIslandDevPeer({ devDependencies: { "@lesto/island-dev": "^0.1.0" } })).toBe(
      true,
    );
  });

  it("is false when neither dependency map names the peer", () => {
    expect(
      declaresIslandDevPeer({ dependencies: { react: "^19" }, devDependencies: { vite: "^7" } }),
    ).toBe(false);
  });

  it("is false when a dependency map is null rather than an object", () => {
    expect(declaresIslandDevPeer({ dependencies: null })).toBe(false);
  });
});

// The shared import-error classifier the bin's optional-module loaders route through
// (`loadSites`/`loadBuildHook` via `isMissingSelfModule`, the content-peer hint via
// `missingModuleSpecifier`). It must span BOTH runtime shapes the bin runs under: the Bun
// `ResolveMessage` (NOT `instanceof Error`, `code: "ERR_MODULE_NOT_FOUND"`) AND the jiti
// `Error` (`code: "MODULE_NOT_FOUND"`, empirically confirmed against jiti 2.7.0).
describe("missingModuleSpecifier — cross-runtime module-not-found classifier", () => {
  it("is undefined for a non-object / null error (no code or message to read)", () => {
    expect(missingModuleSpecifier(undefined)).toBeUndefined();
    expect(missingModuleSpecifier(null)).toBeUndefined();
    expect(missingModuleSpecifier("Cannot find module 'x'")).toBeUndefined();
  });

  it("is undefined when the error object carries no `code`", () => {
    expect(missingModuleSpecifier({ message: "Cannot find module 'x'" })).toBeUndefined();
  });

  it("is undefined when the error object carries no `message`", () => {
    expect(missingModuleSpecifier({ code: "MODULE_NOT_FOUND" })).toBeUndefined();
  });

  it("is undefined for an unrelated error code", () => {
    expect(
      missingModuleSpecifier({ code: "ERR_SYNTAX", message: "Cannot find module 'x'" }),
    ).toBeUndefined();
  });

  it("extracts the specifier under Node/ESM's ERR_MODULE_NOT_FOUND (`Cannot find package … imported from …`)", () => {
    // Node throws a real Error naming the missing PACKAGE, then the (UNquoted) importer
    // path — only the first quoted specifier is returned. (Real Node wording, verified.)
    expect(
      missingModuleSpecifier(
        Object.assign(
          new Error("Cannot find package '@lesto/content-core' imported from /app/bin.ts"),
          { code: "ERR_MODULE_NOT_FOUND" },
        ),
      ),
    ).toBe("@lesto/content-core");
  });

  it("extracts the specifier under Bun's ERR_MODULE_NOT_FOUND (`Cannot find module … from …`, NOT instanceof Error)", () => {
    // Bun's `ResolveMessage` is NOT `instanceof Error` (a bare object with the two reliable
    // fields is the faithful stand-in) and uses `module … from '<importer>'` wording —
    // distinct from Node's `package … imported from …`. The regex spans both; the importer
    // is ignored. (Real Bun 1.3.x wording, verified.)
    expect(
      missingModuleSpecifier({
        code: "ERR_MODULE_NOT_FOUND",
        message: "Cannot find module '@lesto/content-core' from '/app/bin.ts'",
      }),
    ).toBe("@lesto/content-core");
  });

  it("extracts the specifier under jiti's MODULE_NOT_FOUND (a real Error from the CJS resolver)", () => {
    const error = Object.assign(new Error("Cannot find module '/proj/lesto.sites.ts'"), {
      code: "MODULE_NOT_FOUND",
    });

    expect(missingModuleSpecifier(error)).toBe("/proj/lesto.sites.ts");
  });

  it("is undefined when the code matches but the message has no extractable specifier", () => {
    expect(
      missingModuleSpecifier({ code: "MODULE_NOT_FOUND", message: "the graph is broken" }),
    ).toBeUndefined();
  });

  // Task 2 (L-c87b7e68): the bin's OPTIONAL-PEER content loaders (`loadContentCore` /
  // `loadContentStore`) have NO dir-probe guard — they rely on `import()` THROWING when the
  // peer is absent, then `rethrowUnlessMissingContentPeer` classifies the miss into the coded
  // `CLI_CONTENT_PACKAGES_MISSING` hint. EMPIRICALLY, jiti's `import()` of a missing PACKAGE
  // THROWS within a few ms (it does NOT hang) — as a real `Error` with `code:
  // "MODULE_NOT_FOUND"`, NOT the ESM `ERR_MODULE_NOT_FOUND`. So the classifier must recognize
  // BOTH shapes; a `@lesto/content-*` specifier surfacing from EITHER proves the hint path is
  // reached (rather than the raw error rethrown — the gap the old `ERR_MODULE_NOT_FOUND`-only
  // test left open under `node`'s jiti loader), and that a missing peer never hangs.
  it("recognizes a missing @lesto/content-* peer under BOTH runtime codes (the coded-hint path)", () => {
    // Bun: a ResolveMessage-shaped miss (NOT instanceof Error) with ERR_MODULE_NOT_FOUND,
    // in Bun's real `module … from '<importer>'` wording (verified against Bun 1.3.x).
    const bunShape = missingModuleSpecifier({
      code: "ERR_MODULE_NOT_FOUND",
      message: "Cannot find module '@lesto/content-core/build' from '/app/src/bin.ts'",
    });

    // jiti: a real Error from the CJS resolver with MODULE_NOT_FOUND.
    const jitiShape = missingModuleSpecifier(
      Object.assign(new Error("Cannot find module '@lesto/content-store'"), {
        code: "MODULE_NOT_FOUND",
      }),
    );

    // Both extract a `@lesto/content-*` specifier → `rethrowUnlessMissingContentPeer`'s
    // `startsWith("@lesto/content-")` fires → the coded hint, not a hang or a raw rethrow.
    expect(bunShape?.startsWith("@lesto/content-")).toBe(true);
    expect(jitiShape?.startsWith("@lesto/content-")).toBe(true);
  });

  // L-365bef9d: the bin's `loadIslandDevPeer` (the optional `@lesto/island-dev` Fast-Refresh
  // peer) is the exact twin of the content-peer loader — it lazily `import()`s the bare peer
  // specifier and, when it is not installed, must degrade to the Bun island path rather than
  // crash `lesto dev`. Routing its catch through this SHARED classifier (replacing the old
  // `instanceof Error` + `ERR_MODULE_NOT_FOUND`-only gate) makes it recognize the miss under
  // BOTH runtime shapes: the Bun `ResolveMessage` (NOT `instanceof Error`, `ERR_MODULE_NOT_FOUND`)
  // AND the node/jiti `Error` (`MODULE_NOT_FOUND`). The old gate matched neither on `node`
  // (jiti's `MODULE_NOT_FOUND`) nor on Bun's non-`Error` shape → a raw rethrow instead of the
  // tolerant `undefined` fallback. A `@lesto/island-dev` specifier surfacing from EITHER shape
  // proves the exact-equality check `loadIslandDevPeer` gates on (`=== "@lesto/island-dev"`) fires.
  it("recognizes a missing @lesto/island-dev peer under BOTH runtime codes (the tolerant-degrade path)", () => {
    // Bun: a ResolveMessage-shaped miss (NOT instanceof Error) with ERR_MODULE_NOT_FOUND,
    // in Bun's real `module … from '<importer>'` wording (verified against Bun 1.3.x).
    const bunShape = missingModuleSpecifier({
      code: "ERR_MODULE_NOT_FOUND",
      message: "Cannot find module '@lesto/island-dev' from '/app/src/bin.ts'",
    });

    // jiti (node): a real Error from the CJS resolver with MODULE_NOT_FOUND — the shape the
    // old `ERR_MODULE_NOT_FOUND`-only gate silently dropped, rethrowing a raw crash.
    const jitiShape = missingModuleSpecifier(
      Object.assign(new Error("Cannot find module '@lesto/island-dev'"), {
        code: "MODULE_NOT_FOUND",
      }),
    );

    // Both extract exactly `@lesto/island-dev` → `loadIslandDevPeer`'s equality check fires →
    // `undefined` (the Bun island fallback), not a raw rethrow that crashes the dev boot.
    expect(bunShape).toBe("@lesto/island-dev");
    expect(jitiShape).toBe("@lesto/island-dev");
  });

  // The guardrail on that exact-equality gate: a MISSING TRANSITIVE inside an INSTALLED
  // `@lesto/island-dev` (a broken sub-dependency, a removed `@lesto/assets` export) resolves to
  // a DIFFERENT specifier — so `loadIslandDevPeer`'s `=== "@lesto/island-dev"` is false and the
  // error rethrows (fail loud), never masked as "peer absent". A dev who installed it for Fast
  // Refresh must not silently get nothing when its own graph is broken.
  it("extracts the TRANSITIVE specifier (not the island-dev peer) when a sub-dependency is missing", () => {
    const transitive = missingModuleSpecifier(
      Object.assign(
        new Error("Cannot find package '@lesto/assets' imported from /app/island-dev.js"),
        {
          code: "ERR_MODULE_NOT_FOUND",
        },
      ),
    );

    expect(transitive).toBe("@lesto/assets");
    expect(transitive === "@lesto/island-dev").toBe(false);
  });
});

// The self-module predicate `loadSites`/`loadBuildHook` use to tell an absent OPTIONAL
// file (tolerate) from a real failure inside a present one (fail loud). The match is
// ABSOLUTE-PATH equality, NOT a bare suffix — the red-team P2 tightening.
describe("isMissingSelfModule — absolute-path equality (not a bare suffix)", () => {
  const SELF = "/proj/lesto.sites.ts";

  it("is true when the missing specifier IS the self file (delete-between-probe-and-import)", () => {
    const error = { code: "ERR_MODULE_NOT_FOUND", message: `Cannot find module '${SELF}'` };

    expect(isMissingSelfModule(error, SELF)).toBe(true);
  });

  it("normalises before comparing, so a `.`/`..`-laden path to the same file still matches", () => {
    const error = {
      code: "MODULE_NOT_FOUND",
      message: "Cannot find module '/proj/sub/../lesto.sites.ts'",
    };

    expect(isMissingSelfModule(error, SELF)).toBe(true);
  });

  it("is FALSE for a transitive dep whose specifier merely ENDS in the self basename", () => {
    // The footgun the tightening closes: a real, MISSING transitive import
    // `./nested/lesto.sites.ts` — a bare `endsWith("lesto.sites.ts")` would have
    // false-swallowed it as "no sites"; absolute-path equality rethrows it (fail loud).
    const error = {
      code: "MODULE_NOT_FOUND",
      message: "Cannot find module '/proj/nested/lesto.sites.ts'",
    };

    expect(isMissingSelfModule(error, SELF)).toBe(false);
  });

  it("is false when the error is not a missing-module error at all", () => {
    expect(isMissingSelfModule({ code: "ERR_SYNTAX", message: "bad token" }, SELF)).toBe(false);
  });
});
