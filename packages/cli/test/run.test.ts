import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTableSql, defineTable, dropTableSql, integer, text } from "@volo/db";
import { currentContext, currentRequestSpan, volo, runWithContext } from "@volo/web";
import { Migrator } from "@volo/migrate";
import { contentEntriesMigration } from "@volo/content-store";
import type { App, VoloAppConfig, KernelDatabase } from "@volo/kernel";
import type { MigrationEntry } from "@volo/migrate";
import type { RuntimeEntry } from "@volo/content-core";
import type { Server, ServeOptions } from "@volo/runtime";

import type { OutputSink, Site } from "@volo/sites";
import type { ReleaseStore } from "@volo/deploy";

import { CliError, parsePort, parseStringFlag, run } from "../src/index";
import type { CliDeps, ReleaseTarget } from "../src/index";

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

// The default app every command test runs against: a code-first `volo()` app
// (VoloAppConfig). `GET /posts` answers 200 with `{ posts: [] }` and anything
// unmatched 404s — so the build/deploy/dev tests render over a real app.
function buildConfig(): VoloAppConfig {
  const app = volo()
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
  it("prints every route from the volo() app as method\\tpattern and returns 0", async () => {
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

/** Pull the readiness probe out of the health option the serve command wired. */
function readinessProbe(serve: ReturnType<typeof fakeServe>): () => Promise<boolean> {
  const [, options] = serve.mock.calls[0]!;
  const health = options?.health;

  if (!health) throw new Error("serve was called without a health option");

  if (!health.isReady) throw new Error("health option carried no isReady probe");

  return health.isReady as () => Promise<boolean>;
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

  it("wires no tracer on serve when VOLO_OTLP_URL is unset", async () => {
    const serve = fakeServe(3000);

    await run(["serve"], depsWith({ serve, env: {} }));

    const [, options] = serve.mock.calls[0]!;

    expect(options?.tracer).toBeUndefined();
    expect(options?.onDrain).toBeUndefined();
  });

  it("wires the OTLP tracer on serve when VOLO_OTLP_URL is set, and stops the interval on shutdown", async () => {
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
        env: { VOLO_OTLP_URL: "http://collector:4318/v1/traces" },
      }),
    );

    const [, options] = serve.mock.calls[0]!;

    expect(options?.tracer).toBeDefined();
    expect(typeof options?.onDrain).toBe("function");

    // The shutdown hook drains, then stops the flush interval — it resolves cleanly.
    const drain = installShutdown.mock.calls[0]![0] as () => Promise<void>;
    await expect(drain()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("wires /readyz to a real database ping that answers true when the DB is up", async () => {
    const serve = fakeServe(3000);

    await run(["serve"], depsWith({ serve }));

    // The probe runs SELECT 1 against the live in-memory database → ready.
    expect(await readinessProbe(serve)()).toBe(true);
  });

  it("reports not-ready when the database ping throws (a down/failing DB)", async () => {
    const serve = fakeServe(3000);

    // A volo() app over a database whose query rejects — and no migrations, so
    // boot never touches it; only the readiness probe does.
    const downConfig: VoloAppConfig = {
      db: {
        exec: () => Promise.resolve(),
        prepare: () => ({
          run: () => Promise.reject(new Error("db down")),
          get: () => Promise.reject(new Error("db down")),
          all: () => Promise.reject(new Error("db down")),
        }),
        transaction: (fn) => fn(downConfig.db),
      },
      app: volo().get("/", (c) => c.text("ok")),
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

  it("wires no tracer on dev when VOLO_OTLP_URL is unset (tracing off by default)", async () => {
    const serve = fakeServe(5173);

    await run(["dev"], depsWith({ serve, env: {}, loadSites: () => Promise.resolve(sites) }));

    const [, options] = serve.mock.calls[0]!;

    expect(options?.tracer).toBeUndefined();
    expect(options?.onDrain).toBeUndefined();
  });

  it("wires the OTLP tracer on dev when VOLO_OTLP_URL is set, flushing on drain", async () => {
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
          env: { VOLO_OTLP_URL: "http://collector:4318/v1/traces", VOLO_OTLP_SERVICE: "estate" },
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
// ADR 0011 Seam 3: the CLI runs the @volo/assets client build when the project
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
    expect(built).toEqual([{ outDir: "out", mode: "production", dialect: "react" }]);
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
        outDir: "out",
        mode: "production",
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

    // No `volo.sites.ts` → the bin's loader resolves to `[]`; dev must still serve
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
        // A volo() app config that opts into the Preact dialect — the single key
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

describe("run deploy", () => {
  // Two zones: a static marketing root (two pages) and a dynamic mls app. Both
  // marketing routes map to posts#index so they render 200 and ship as 2 routes.
  const sites: readonly Site[] = [
    { name: "marketing", render: "static", basePath: "/", pages: ["/posts", "/more"] },
    { name: "mls", render: "dynamic", basePath: "/mls" },
  ];

  function twoRouteConfig(): VoloAppConfig {
    const app = volo()
      .get("/posts", (c) => c.json({ posts: [] }))
      .get("/more", (c) => c.json({ posts: [] }));

    return {
      db: adapt(database),
      app,
      migrations,
    };
  }

  const loadApp = (): Promise<VoloAppConfig> => Promise.resolve(twoRouteConfig());

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
      "mls: run `volo serve` (dynamic)",
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
    // rather than print only "run `volo serve`" and look like it did nothing.
    const dynamicOnly: readonly Site[] = [{ name: "app", render: "dynamic", basePath: "/" }];

    const code = await run(
      ["deploy"],
      depsWith({ loadApp, loadSites: () => Promise.resolve(dynamicOnly), sink, uploader }),
    );

    expect(code).toBe(0);
    // Nothing was uploaded by the copy shipper.
    expect(shipped.size).toBe(0);
    expect(lines).toEqual([
      "app: run `volo serve` (dynamic)",
      "route / → dynamic",
      "no static routes to ship — deploy the live app with `volo deploy --cloudflare` " +
        "(Worker + assets via wrangler) or self-host it with `volo serve`",
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
      "mls: run `volo serve` (dynamic)",
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
    expect(lines[0]).toContain("volo — the Volo command-line tool");
    expect(lines[0]).toContain("routes");
    expect(lines[0]).toContain("deploy");
  });

  it("prints usage for an empty command", async () => {
    const code = await run([], depsWith());

    expect(code).toBe(0);
    expect(lines[0]).toContain("Usage: volo <command>");
  });

  it("prints usage for an empty-string command", async () => {
    const code = await run([""], depsWith());

    expect(code).toBe(0);
    expect(lines[0]).toContain("Usage: volo <command>");
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
    // The app's migrations create the content_entries table on boot; mirror
    // that here by migrating the same in-memory database the config wraps.
    await new Migrator(adapt(database), [contentEntriesMigration]).migrate();

    const entries = [
      entry("posts", "hello", { title: "Hello" }),
      entry("posts", "world", { title: "World" }),
    ];

    const code = await run(
      ["content:build"],
      depsWith({ buildContent: () => Promise.resolve(entries) }),
    );

    expect(code).toBe(0);
    expect(lines).toEqual(["built 2 entries into the content store"]);

    const count = database.prepare("SELECT COUNT(*) AS n FROM content_entries").get() as {
      n: number;
    };
    expect(count.n).toBe(2);
  });

  it("says 'entry' (singular) for a single built entry", async () => {
    await new Migrator(adapt(database), [contentEntriesMigration]).migrate();

    const code = await run(
      ["content:build"],
      depsWith({
        buildContent: () => Promise.resolve([entry("posts", "solo", { title: "Solo" })]),
      }),
    );

    expect(code).toBe(0);
    expect(lines).toEqual(["built 1 entry into the content store"]);
  });

  it("with --prune, drops entries the build no longer produces", async () => {
    await new Migrator(adapt(database), [contentEntriesMigration]).migrate();

    // A first build writes two entries.
    const both = [entry("posts", "keep", {}), entry("posts", "stale", {})];
    await run(["content:build"], depsWith({ buildContent: () => Promise.resolve(both) }));
    lines = [];

    // The next build only produces "keep"; --prune removes the orphaned "stale".
    const code = await run(
      ["content:build", "--prune"],
      depsWith({ buildContent: () => Promise.resolve([entry("posts", "keep", {})]) }),
    );

    expect(code).toBe(0);
    expect(lines).toEqual(["built 1 entry into the content store", "pruned 1 stale entry"]);

    const count = database.prepare("SELECT COUNT(*) AS n FROM content_entries").get() as {
      n: number;
    };
    expect(count.n).toBe(1);
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
    await new Migrator(adapt(database), [contentEntriesMigration]).migrate();
    await run(
      ["content:build"],
      depsWith({
        buildContent: () => Promise.resolve([entry("posts", "doomed", { title: "Doomed" })]),
      }),
    );
    lines = [];

    const code = await run(["content:delete", "posts", "doomed"], depsWith());

    expect(code).toBe(0);
    expect(lines).toEqual(["deleted posts entry: doomed"]);
  });

  it("reports when there was nothing to delete", async () => {
    await new Migrator(adapt(database), [contentEntriesMigration]).migrate();

    const code = await run(["content:delete", "posts", "ghost"], depsWith());

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
    // `volo build --out --target blog` means `--out` was given no value; the
    // parser must not swallow the next flag (`--target`) as `--out`'s value, or a
    // value-less `--out` would silently become `"--target"` and never write a dir.
    expect(parseStringFlag(["--out", "--target", "blog"], "out")).toBeUndefined();
  });

  it("does NOT consume a following flag even when that flag is the last token", () => {
    // The guard fires on the `--` prefix, not on there being a token after it.
    expect(parseStringFlag(["--target", "--out"], "target")).toBeUndefined();
  });
});
