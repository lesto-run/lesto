import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  agentsMd,
  claudeMd,
  CreateLestoError,
  fileColonPin,
  gitignore,
  islandCounter,
  lestoApp,
  lestoSites,
  LESTO_PACKAGES,
  packageJson,
  publishedRangePin,
  readme,
  routeLayout,
  routePage,
  scaffold,
  tsconfig,
  worker,
  wranglerConfig,
} from "../src/index";

import type { LestoDepResolver, ScaffoldIO } from "../src/index";

// A deterministic dep resolver for the pure-template tests: pin every @lesto/*
// package to a fake `file:` path, so a test never depends on the repo layout.
const fakePin: LestoDepResolver = (pkg) => `file:/fake/packages/${pkg.replace("@lesto/", "")}`;

// A real node:fs/promises-backed ScaffoldIO, the same shape bin.ts wires up.
const realIO: ScaffoldIO = {
  mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
  writeFile: (path, content) => writeFile(path, content),
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
};

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "create-lesto-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("scaffold", () => {
  it("writes every starter file and returns the sorted manifest", async () => {
    const targetDir = join(workspace, "my-app");

    const written = await scaffold({ name: "my-app", targetDir }, realIO);

    const expected = [
      "package.json",
      "env.ts",
      "lesto.app.ts",
      "lesto.sites.ts",
      "app/routes/page.tsx",
      "app/routes/layout.tsx",
      "app/islands/counter.tsx",
      "worker.ts",
      "wrangler.jsonc",
      "tsconfig.json",
      ".gitignore",
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
    ]
      .map((relative) => join(targetDir, relative))
      .toSorted();

    expect(written).toEqual(expected);

    // The returned manifest is sorted.
    expect([...written]).toEqual(written.toSorted());

    // Every returned path really exists on disk.
    for (const path of written) {
      await expect(access(path)).resolves.toBeUndefined();
    }
  });

  it("scaffolds an app config and the @lesto deps into real files", async () => {
    const targetDir = join(workspace, "blogish");

    await scaffold({ name: "blogish", targetDir }, realIO);

    const app = await readFile(join(targetDir, "lesto.app.ts"), "utf8");
    const pkg = await readFile(join(targetDir, "package.json"), "utf8");

    // lesto.app.ts default-exports the LestoAppConfig and declares the parts.
    expect(app).toContain("export default config");
    expect(app).toContain("const config: LestoAppConfig");
    expect(app).toContain('defineTable("posts"');
    expect(app).toContain("createTableSql(posts)");
    expect(app).toContain("buildApp(db)");
    expect(app).toContain('.get("/posts"');
    expect(app).toContain('.post("/posts"');

    // The two conventions the starter demonstrates: boundary validation with
    // Zod via c.valid, and security declared in one place via the config's
    // `secure` field (rate-limit from the kernel default + originCheck CSRF).
    expect(app).toContain("c.valid(NewPost)");
    expect(app).toContain("z.object({");
    expect(app).toContain("secure: { originCheck: {} }");

    // The Preact-by-default island pipeline: the single ui.dialect key and the
    // client module tag. The HOME PAGE moved to app/routes/page.tsx (file-based
    // routing), so lesto.app.ts no longer registers a `.page("/")` or imports the
    // island directly — it stays a pure data/API surface.
    expect(app).toContain('ui: { dialect: "preact" }');
    expect(app).toContain('.client("/client.js")');
    expect(app).not.toContain('.page("/"');
    expect(app).not.toContain('import Counter from "./app/islands/counter"');

    // Typed env on day one: the DB path comes from `env.LESTO_DB` (via `./env`),
    // not a bare `process.env` or a hardcoded literal.
    expect(app).toContain('import { env } from "./env"');
    expect(app).toContain("openSqlite(env.LESTO_DB)");
    expect(app).not.toContain('openSqlite("lesto.db")');
    expect(app).not.toContain("process.env");

    // package.json carries the project name, the @lesto deps, and the run scripts.
    const manifest = JSON.parse(pkg) as {
      name: string;
      type: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };

    expect(manifest.name).toBe("blogish");
    expect(manifest.type).toBe("module");
    expect(manifest.scripts["dev"]).toBe("lesto dev");
    expect(manifest.scripts["build"]).toBe("lesto build");

    for (const dep of [
      // The CLI (the `lesto` binary) and the asset pipeline — their absence was
      // blocker #9's silent break.
      "@lesto/cli",
      "@lesto/assets",
      // The edge adapter the deploy template's worker.ts fronts the app with.
      "@lesto/cloudflare",
      "@lesto/db",
      // The typed, validated environment the scaffold reads its DB path through.
      "@lesto/env",
      "@lesto/kernel",
      "@lesto/migrate",
      "@lesto/web",
      "@lesto/ui",
      "@lesto/runtime",
      "preact",
      "preact-render-to-string",
      "react",
      "react-dom",
      "better-sqlite3",
      "zod",
    ]) {
      expect(manifest.dependencies[dep]).toBeDefined();
    }

    // @lesto/* deps default to published ^0.x ranges (the outsider path — `--local`
    // swaps to file: pins). This locks the default the scaffold actually emits.
    for (const lestoPkg of LESTO_PACKAGES) {
      expect(manifest.dependencies[lestoPkg]).toMatch(/^\^0\./);
    }

    // The legacy @lesto/orm dep is gone — scaffolded apps use @lesto/db.
    expect(manifest.dependencies["@lesto/orm"]).toBeUndefined();

    // Routes live on the code-first lesto() app now — no legacy @lesto/router dep.
    expect(manifest.dependencies["@lesto/router"]).toBeUndefined();
  });

  it("scaffolds lesto.sites.ts and the island module", async () => {
    const targetDir = join(workspace, "sited");

    await scaffold({ name: "sited", targetDir }, realIO);

    const sites = await readFile(join(targetDir, "lesto.sites.ts"), "utf8");
    const island = await readFile(join(targetDir, "app/islands/counter.tsx"), "utf8");

    // lesto.sites.ts default-exports a Site[] with one dynamic root zone.
    expect(sites).toContain("export default sites");
    expect(sites).toContain('render: "dynamic"');
    expect(sites).toContain('basePath: "/"');

    // The island is one defineIsland default-export — the convention the build
    // discovers and bundles into /client.js.
    expect(island).toContain("export default defineIsland({");
    expect(island).toContain('name: "Counter"');
    expect(island).toContain("useState");
  });

  it("scaffolds a typed env.ts wired to @lesto/env", async () => {
    const targetDir = join(workspace, "enved");

    await scaffold({ name: "enved", targetDir }, realIO);

    const envFile = await readFile(join(targetDir, "env.ts"), "utf8");

    // env.ts is a `defineEnv` schema over `envField`, default-exported as `env`,
    // demonstrating the DB-path knob with a default (so the starter boots with none set).
    expect(envFile).toContain('import { defineEnv, envField } from "@lesto/env"');
    expect(envFile).toContain("export const env = defineEnv({");
    expect(envFile).toContain('LESTO_DB: envField.string().default("lesto.db")');
  });

  it("scaffolds the file-routed home page + layout and the agent onboarding files", async () => {
    const targetDir = join(workspace, "routed");

    await scaffold({ name: "routed", targetDir }, realIO);

    const page = await readFile(join(targetDir, "app/routes/page.tsx"), "utf8");
    const layout = await readFile(join(targetDir, "app/routes/layout.tsx"), "utf8");
    const agents = await readFile(join(targetDir, "AGENTS.md"), "utf8");
    const claude = await readFile(join(targetDir, "CLAUDE.md"), "utf8");

    // The home page is a JSX PageDef (not createElement) registered at "/" by the
    // file convention, rendering the Counter island via PageProps inference.
    expect(page).toContain('PageDef<"/"');
    expect(page).toContain("PageProps<typeof load>");
    expect(page).toContain("<Counter start={start} />");
    expect(page).toContain('import Counter from "../islands/counter"');
    expect(page).not.toContain("createElement");

    // The root layout wraps every page as children.
    expect(layout).toContain("export default function RootLayout");
    expect(layout).toContain("children");

    // The agent files: AGENTS.md is the source of truth, CLAUDE.md defers to it.
    expect(agents).toContain("# routed — agent guide");
    expect(agents).toContain("app/routes/");
    expect(claude).toContain("AGENTS.md");
  });

  it("scaffolds the Cloudflare deploy files (worker.ts + wrangler.jsonc)", async () => {
    const targetDir = join(workspace, "edgey");

    await scaffold({ name: "edgey", targetDir }, realIO);

    const workerTs = await readFile(join(targetDir, "worker.ts"), "utf8");
    const wrangler = await readFile(join(targetDir, "wrangler.jsonc"), "utf8");

    // worker.ts is the thin @lesto/cloudflare adapter: toFetchHandler over the edge
    // app, fronted by the ASSETS binding via withAssets.
    expect(workerTs).toContain('from "@lesto/cloudflare"');
    expect(workerTs).toContain("toFetchHandler");
    expect(workerTs).toContain("withAssets(env.ASSETS, handler)");
    // It builds its own minimal edge twin (the island home page), never importing
    // lesto.app.ts — which opens a filesystem SQLite handle a Worker has no fs for.
    expect(workerTs).not.toContain('from "./lesto.app"');
    expect(workerTs).toContain('import Counter from "./app/islands/counter"');

    // wrangler.jsonc is valid JSONC (comments + trailing commas) wiring the
    // nodejs_compat flag, the worker entry, and the ASSETS binding rooted at out/.
    expect(wrangler).toContain('"name": "edgey"');
    expect(wrangler).toContain('"main": "worker.ts"');
    expect(wrangler).toContain("nodejs_compat");
    expect(wrangler).toContain('"binding": "ASSETS"');
    expect(wrangler).toContain('"directory": "./out"');
  });

  it("refuses to clobber an existing target", async () => {
    const targetDir = join(workspace, "taken");

    // Pre-create the directory so io.exists is true.
    await mkdir(targetDir, { recursive: true });

    const error = await scaffold({ name: "taken", targetDir }, realIO).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CreateLestoError);
    expect((error as CreateLestoError).code).toBe("CREATE_LESTO_TARGET_EXISTS");
    expect((error as CreateLestoError).details).toEqual({ targetDir });

    // details are frozen.
    expect(Object.isFrozen((error as CreateLestoError).details)).toBe(true);
  });

  it("reports CREATE_LESTO_TARGET_EXISTS through a fake io without touching disk", async () => {
    let wrote = false;

    const fakeIO: ScaffoldIO = {
      exists: () => Promise.resolve(true),
      mkdir: () => Promise.reject(new Error("should not mkdir")),
      writeFile: () => {
        wrote = true;
        return Promise.reject(new Error("should not write"));
      },
    };

    const error = await scaffold({ name: "x", targetDir: "/anywhere" }, fakeIO).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CreateLestoError);
    expect(wrote).toBe(false);
  });
});

describe("templates", () => {
  it("packageJson embeds the name and parses as JSON", () => {
    const parsed = JSON.parse(packageJson("acme", fakePin)) as { name: string };

    expect(parsed.name).toBe("acme");
  });

  it("declares the scaffolded app UNLICENSED (the user's own private project)", () => {
    const parsed = JSON.parse(packageJson("acme", fakePin)) as {
      private: boolean;
      license: string;
    };

    // A generated app is private and ships no license of its own — the author
    // picks one; it never inherits Lesto's MIT.
    expect(parsed.private).toBe(true);
    expect(parsed.license).toBe("UNLICENSED");
  });

  it("pins every @lesto dep through the injected resolver, never the workspace protocol", () => {
    const parsed = JSON.parse(packageJson("acme", fakePin)) as {
      dependencies: Record<string, string>;
    };

    const lestoDeps = Object.entries(parsed.dependencies).filter(([name]) =>
      name.startsWith("@lesto/"),
    );

    // Every package in LESTO_PACKAGES is present (guards against a vacuous pass).
    expect(lestoDeps.map(([name]) => name).toSorted()).toEqual([...LESTO_PACKAGES].toSorted());

    for (const [name, specifier] of lestoDeps) {
      // `workspace:*` resolves only inside this monorepo; a scaffolded app would
      // fail to install. The resolver pins each to a real, resolvable specifier.
      expect(specifier).not.toContain("workspace:");
      expect(specifier).toBe(fakePin(name as (typeof LESTO_PACKAGES)[number]));
    }
  });

  it("ships preact for the ~10 KB island client AND react for the server render", () => {
    const parsed = JSON.parse(packageJson("acme", fakePin)) as {
      dependencies: Record<string, string>;
    };

    expect(parsed.dependencies["preact"]).toBeDefined();
    expect(parsed.dependencies["react"]).toBeDefined();
    expect(parsed.dependencies["react-dom"]).toBeDefined();
  });

  it("lestoApp default-exports a LestoAppConfig with the preact dialect", () => {
    expect(lestoApp()).toContain("export default config");
    expect(lestoApp()).toContain("const config: LestoAppConfig");
    expect(lestoApp()).toContain('ui: { dialect: "preact" }');
  });

  it("islandCounter is one defineIsland default-export", () => {
    expect(islandCounter()).toContain("export default defineIsland({");
    expect(islandCounter()).toContain('name: "Counter"');
  });

  it("routePage is a JSX PageDef at / (no createElement)", () => {
    const out = routePage();

    expect(out).toContain('PageDef<"/"');
    expect(out).toContain("export default page");
    expect(out).toContain("PageProps<typeof load>");
    expect(out).not.toContain("createElement");
  });

  it("routeLayout default-exports a layout that renders its children", () => {
    const out = routeLayout();

    expect(out).toContain("export default function RootLayout");
    expect(out).toContain("{children}");
  });

  it("agentsMd names the project and documents the file-routing convention", () => {
    const out = agentsMd("acme");

    expect(out).toContain("# acme — agent guide");
    expect(out).toContain("app/routes/");
    expect(out).toContain("file-based routing");
  });

  it("claudeMd defers to AGENTS.md as the single source of truth", () => {
    const out = claudeMd("acme");

    expect(out).toContain("# acme");
    expect(out).toContain("AGENTS.md");
  });

  it("lestoSites default-exports a Site[] with a dynamic root zone", () => {
    expect(lestoSites()).toContain("export default sites");
    expect(lestoSites()).toContain('render: "dynamic"');
  });

  it("tsconfig is bundler-resolution, strict JSON that includes the island dir", () => {
    const parsed = JSON.parse(tsconfig()) as {
      compilerOptions: { moduleResolution: string; strict: boolean };
      include: string[];
    };

    expect(parsed.compilerOptions.moduleResolution).toBe("Bundler");
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(parsed.include).toContain("app");
  });

  it("gitignore ignores node_modules, the db file, and SECRETS (.env*), but keeps .env.example", () => {
    const out = gitignore();
    const lines = out.split("\n");

    expect(out).toContain("node_modules/");
    expect(out).toContain("*.db");

    // Secrets must not be committable: Bun auto-loads `.env`/`.env.local` into
    // process.env, so they hold secrets and must be ignored — every `.env` variant.
    expect(lines).toContain(".env");
    expect(lines).toContain(".env.*");
    // ...except the secret-free template, re-included by negation.
    expect(lines).toContain("!.env.example");
  });

  it("readme names the project", () => {
    expect(readme("acme")).toContain("# acme");
  });

  it("readme documents the one-command Cloudflare deploy path", () => {
    const out = readme("acme");

    expect(out).toContain("## Deploy to Cloudflare");
    expect(out).toContain("lesto deploy --cloudflare");
  });

  it("worker fronts the app with @lesto/cloudflare's toFetchHandler + withAssets", () => {
    const out = worker();

    expect(out).toContain('from "@lesto/cloudflare"');
    expect(out).toContain("toFetchHandler");
    expect(out).toContain("withAssets(env.ASSETS, handler)");
    // The edge twin builds its own island home page rather than importing the
    // SQLite-booting lesto.app.ts.
    expect(out).not.toContain('from "./lesto.app"');
    expect(out).toContain('import Counter from "./app/islands/counter"');
  });

  it("wranglerConfig embeds the name and is valid JSON once its comments are stripped", () => {
    const out = wranglerConfig("acme");

    // The raw file carries JSONC comments and a trailing comma — both legal JSONC,
    // which is what wrangler reads. Strip them to assert the underlying shape.
    const stripped = out
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n")
      .replace(/,(\s*[}\]])/g, "$1");

    const parsed = JSON.parse(stripped) as {
      name: string;
      main: string;
      compatibility_flags: string[];
      assets: { directory: string; binding: string };
    };

    expect(parsed.name).toBe("acme");
    expect(parsed.main).toBe("worker.ts");
    expect(parsed.compatibility_flags).toContain("nodejs_compat");
    expect(parsed.assets).toEqual({ directory: "./out", binding: "ASSETS" });
  });
});

describe("dep resolvers", () => {
  it("publishedRangePin (the default) pins every @lesto dep at a published ^0.x range", () => {
    for (const pkg of LESTO_PACKAGES) {
      const specifier = publishedRangePin(pkg);

      // A registry-resolvable semver range — what an outsider installs. Never a
      // local `file:` path or the monorepo-only `workspace:` protocol.
      expect(specifier).toMatch(/^\^0\./);
      expect(specifier).not.toContain("file:");
      expect(specifier).not.toContain("workspace:");
    }
  });

  it("fileColonPin (the --local mode) pins every @lesto dep at a file: path to the in-repo package", () => {
    for (const pkg of LESTO_PACKAGES) {
      const specifier = fileColonPin(pkg);

      expect(specifier.startsWith("file:")).toBe(true);
      // The path ends at the package's directory name, with the @lesto/ scope stripped.
      expect(specifier).toContain(pkg.replace("@lesto/", ""));
      expect(specifier).not.toContain("@lesto/");
    }
  });
});
