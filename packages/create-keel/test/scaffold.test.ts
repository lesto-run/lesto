import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CreateKeelError,
  fileColonPin,
  gitignore,
  islandCounter,
  keelApp,
  keelSites,
  KEEL_PACKAGES,
  packageJson,
  publishedRangePin,
  readme,
  scaffold,
  tsconfig,
} from "../src/index";

import type { KeelDepResolver, ScaffoldIO } from "../src/index";

// A deterministic dep resolver for the pure-template tests: pin every @keel/*
// package to a fake `file:` path, so a test never depends on the repo layout.
const fakePin: KeelDepResolver = (pkg) => `file:/fake/packages/${pkg.replace("@keel/", "")}`;

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
  workspace = await mkdtemp(join(tmpdir(), "create-keel-"));
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
      "keel.app.ts",
      "keel.sites.ts",
      "app/islands/counter.tsx",
      "tsconfig.json",
      ".gitignore",
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

  it("scaffolds an app config and the @keel deps into real files", async () => {
    const targetDir = join(workspace, "blogish");

    await scaffold({ name: "blogish", targetDir }, realIO);

    const app = await readFile(join(targetDir, "keel.app.ts"), "utf8");
    const pkg = await readFile(join(targetDir, "package.json"), "utf8");

    // keel.app.ts default-exports the KeelAppConfig and declares the parts.
    expect(app).toContain("export default config");
    expect(app).toContain("const config: KeelAppConfig");
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

    // The Preact-by-default island pipeline: the single ui.dialect key, the
    // client module tag, the home page, and the island import.
    expect(app).toContain('ui: { dialect: "preact" }');
    expect(app).toContain('.client("/client.js")');
    expect(app).toContain('.page("/"');
    expect(app).toContain('import Counter from "./app/islands/counter"');

    // package.json carries the project name, the @keel deps, and the run scripts.
    const manifest = JSON.parse(pkg) as {
      name: string;
      type: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };

    expect(manifest.name).toBe("blogish");
    expect(manifest.type).toBe("module");
    expect(manifest.scripts["dev"]).toBe("keel dev");
    expect(manifest.scripts["build"]).toBe("keel build");

    for (const dep of [
      // The CLI (the `keel` binary) and the asset pipeline — their absence was
      // blocker #9's silent break.
      "@keel/cli",
      "@keel/assets",
      "@keel/db",
      "@keel/kernel",
      "@keel/migrate",
      "@keel/web",
      "@keel/ui",
      "@keel/runtime",
      "preact",
      "react",
      "react-dom",
      "better-sqlite3",
      "zod",
    ]) {
      expect(manifest.dependencies[dep]).toBeDefined();
    }

    // @keel/* deps default to published ^0.x ranges (the outsider path — `--local`
    // swaps to file: pins). This locks the default the scaffold actually emits.
    for (const keelPkg of KEEL_PACKAGES) {
      expect(manifest.dependencies[keelPkg]).toMatch(/^\^0\./);
    }

    // The legacy @keel/orm dep is gone — scaffolded apps use @keel/db.
    expect(manifest.dependencies["@keel/orm"]).toBeUndefined();

    // Routes live on the code-first keel() app now — no legacy @keel/router dep.
    expect(manifest.dependencies["@keel/router"]).toBeUndefined();
  });

  it("scaffolds keel.sites.ts and the island module", async () => {
    const targetDir = join(workspace, "sited");

    await scaffold({ name: "sited", targetDir }, realIO);

    const sites = await readFile(join(targetDir, "keel.sites.ts"), "utf8");
    const island = await readFile(join(targetDir, "app/islands/counter.tsx"), "utf8");

    // keel.sites.ts default-exports a Site[] with one dynamic root zone.
    expect(sites).toContain("export default sites");
    expect(sites).toContain('render: "dynamic"');
    expect(sites).toContain('basePath: "/"');

    // The island is one defineIsland default-export — the convention the build
    // discovers and bundles into /client.js.
    expect(island).toContain("export default defineIsland({");
    expect(island).toContain('name: "Counter"');
    expect(island).toContain("useState");
  });

  it("refuses to clobber an existing target", async () => {
    const targetDir = join(workspace, "taken");

    // Pre-create the directory so io.exists is true.
    await mkdir(targetDir, { recursive: true });

    const error = await scaffold({ name: "taken", targetDir }, realIO).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CreateKeelError);
    expect((error as CreateKeelError).code).toBe("CREATE_KEEL_TARGET_EXISTS");
    expect((error as CreateKeelError).details).toEqual({ targetDir });

    // details are frozen.
    expect(Object.isFrozen((error as CreateKeelError).details)).toBe(true);
  });

  it("reports CREATE_KEEL_TARGET_EXISTS through a fake io without touching disk", async () => {
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

    expect(error).toBeInstanceOf(CreateKeelError);
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
    // picks one; it never inherits Keel's MIT.
    expect(parsed.private).toBe(true);
    expect(parsed.license).toBe("UNLICENSED");
  });

  it("pins every @keel dep through the injected resolver, never the workspace protocol", () => {
    const parsed = JSON.parse(packageJson("acme", fakePin)) as {
      dependencies: Record<string, string>;
    };

    const keelDeps = Object.entries(parsed.dependencies).filter(([name]) =>
      name.startsWith("@keel/"),
    );

    // Every package in KEEL_PACKAGES is present (guards against a vacuous pass).
    expect(keelDeps.map(([name]) => name).toSorted()).toEqual([...KEEL_PACKAGES].toSorted());

    for (const [name, specifier] of keelDeps) {
      // `workspace:*` resolves only inside this monorepo; a scaffolded app would
      // fail to install. The resolver pins each to a real, resolvable specifier.
      expect(specifier).not.toContain("workspace:");
      expect(specifier).toBe(fakePin(name as (typeof KEEL_PACKAGES)[number]));
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

  it("keelApp default-exports a KeelAppConfig with the preact dialect", () => {
    expect(keelApp()).toContain("export default config");
    expect(keelApp()).toContain("const config: KeelAppConfig");
    expect(keelApp()).toContain('ui: { dialect: "preact" }');
  });

  it("islandCounter is one defineIsland default-export", () => {
    expect(islandCounter()).toContain("export default defineIsland({");
    expect(islandCounter()).toContain('name: "Counter"');
  });

  it("keelSites default-exports a Site[] with a dynamic root zone", () => {
    expect(keelSites()).toContain("export default sites");
    expect(keelSites()).toContain('render: "dynamic"');
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

  it("gitignore ignores node_modules and the db file", () => {
    const out = gitignore();

    expect(out).toContain("node_modules/");
    expect(out).toContain("*.db");
  });

  it("readme names the project", () => {
    expect(readme("acme")).toContain("# acme");
  });
});

describe("dep resolvers", () => {
  it("publishedRangePin (the default) pins every @keel dep at a published ^0.x range", () => {
    for (const pkg of KEEL_PACKAGES) {
      const specifier = publishedRangePin(pkg);

      // A registry-resolvable semver range — what an outsider installs. Never a
      // local `file:` path or the monorepo-only `workspace:` protocol.
      expect(specifier).toMatch(/^\^0\./);
      expect(specifier).not.toContain("file:");
      expect(specifier).not.toContain("workspace:");
    }
  });

  it("fileColonPin (the --local mode) pins every @keel dep at a file: path to the in-repo package", () => {
    for (const pkg of KEEL_PACKAGES) {
      const specifier = fileColonPin(pkg);

      expect(specifier.startsWith("file:")).toBe(true);
      // The path ends at the package's directory name, with the @keel/ scope stripped.
      expect(specifier).toContain(pkg.replace("@keel/", ""));
      expect(specifier).not.toContain("@keel/");
    }
  });
});
