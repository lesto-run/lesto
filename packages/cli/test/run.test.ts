import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Router } from "@keel/router";
import { Controller } from "@keel/web";
import { resetConnection } from "@keel/orm";
import { Migrator } from "@keel/migrate";
import { contentEntriesMigration } from "@keel/content-store";
import type { ControllerClass, KeelResponse } from "@keel/web";
import type { App, AppConfig, KernelDatabase } from "@keel/kernel";
import type { MigrationEntry } from "@keel/migrate";
import type { RuntimeEntry } from "@keel/content-core";
import type { Server, ServeOptions } from "@keel/runtime";

import type { OutputSink, Site } from "@keel/sites";

import { CliError, parsePort, parseStringFlag, run } from "../src/index";
import type { CliDeps } from "../src/index";

// --- A real-enough app, built over an in-memory better-sqlite3 adapter. ---

class PostsController extends Controller {
  index(): KeelResponse {
    return this.json({ posts: [] });
  }
}

const migrations: MigrationEntry[] = [
  {
    version: "001_create_posts",
    migration: {
      up: (schema) => {
        schema.createTable("posts", (t) => {
          t.string("title", { null: false });
          t.text("body", { null: false });
          t.timestamps();
        });
      },

      down: (schema) => {
        schema.dropTable("posts");
      },
    },
  },
];

// Adapt better-sqlite3 (variadic params) to the kernel's array-positional surface.
function adapt(raw: Database.Database): KernelDatabase {
  return {
    exec: (sql) => raw.exec(sql),

    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: (params = []) => statement.run(...params),
        get: (params = []) => statement.get(...params),
        all: (params = []) => statement.all(...params),
      };
    },
  };
}

let database: Database.Database;

function buildConfig(): AppConfig {
  const router = new Router();

  router.resources("posts");

  return {
    db: adapt(database),
    router,
    controllers: { posts: PostsController as ControllerClass },
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
    uploader: () => ({ read: () => Promise.resolve(""), put: () => Promise.resolve() }),
    out: (line) => lines.push(line),
    ...overrides,
  };
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

  // The ORM connection is global; reset it so tests do not leak into each other.
  resetConnection();
});

describe("run routes", () => {
  it("prints every route from the app's router and returns 0", async () => {
    const code = await run(["routes"], depsWith());

    expect(code).toBe(0);

    // The seven RESTful routes for `resources("posts")`.
    expect(lines).toContain("GET\t/posts\tposts#index");
    expect(lines).toContain("POST\t/posts\tposts#create");
    expect(lines).toContain("GET\t/posts/:id\tposts#show");
    expect(lines).toContain("DELETE\t/posts/:id\tposts#destroy");
    expect(lines).toHaveLength(8);
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

    return (path, contents) => {
      written.set(path, contents);

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
      read: (_outRoot, file) => Promise.resolve(`bytes:${file}`),
      put: (key, contents) => {
        shipped.set(key, contents);

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

  function twoRouteConfig(): AppConfig {
    const router = new Router().get("/posts", "posts#index").get("/more", "posts#index");

    return {
      db: adapt(database),
      router,
      controllers: { posts: PostsController as ControllerClass },
      migrations,
    };
  }

  const loadApp = (): Promise<AppConfig> => Promise.resolve(twoRouteConfig());

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
      "mls: run `keel serve` (dynamic)",
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
});

describe("run help", () => {
  it("prints usage and returns 0", async () => {
    const code = await run(["help"], depsWith());

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("keel — the Keel command-line tool");
    expect(lines[0]).toContain("routes");
    expect(lines[0]).toContain("deploy");
  });

  it("prints usage for an empty command", async () => {
    const code = await run([], depsWith());

    expect(code).toBe(0);
    expect(lines[0]).toContain("Usage: keel <command>");
  });

  it("prints usage for an empty-string command", async () => {
    const code = await run([""], depsWith());

    expect(code).toBe(0);
    expect(lines[0]).toContain("Usage: keel <command>");
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
    new Migrator(adapt(database), [contentEntriesMigration]).migrate();

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
    new Migrator(adapt(database), [contentEntriesMigration]).migrate();

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
    new Migrator(adapt(database), [contentEntriesMigration]).migrate();

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
    new Migrator(adapt(database), [contentEntriesMigration]).migrate();
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
    new Migrator(adapt(database), [contentEntriesMigration]).migrate();

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

  it("takes the immediately-following token verbatim, even if it looks like a flag", () => {
    // Documented semantics: the value is whatever follows the flag. The command
    // then validates it (e.g. an unknown --target name is a clear error).
    expect(parseStringFlag(["--target", "--out"], "target")).toBe("--out");
  });
});
