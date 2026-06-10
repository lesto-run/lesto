import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CreateKeelError,
  gitignore,
  keelApp,
  packageJson,
  readme,
  scaffold,
  tsconfig,
} from "../src/index";

import type { ScaffoldIO } from "../src/index";

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

    const expected = ["package.json", "keel.app.ts", "tsconfig.json", ".gitignore", "README.md"]
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

    // keel.app.ts default-exports the AppConfig and declares the parts.
    expect(app).toContain("export default config");
    expect(app).toContain("const config: AppConfig");
    expect(app).toContain('defineTable("posts"');
    expect(app).toContain("createTableSql(posts)");
    expect(app).toContain("buildControllers(db)");
    expect(app).toContain('resources("posts")');

    // package.json carries the project name, the @keel deps, and the dev script.
    const manifest = JSON.parse(pkg) as {
      name: string;
      type: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };

    expect(manifest.name).toBe("blogish");
    expect(manifest.type).toBe("module");
    expect(manifest.scripts["dev"]).toBe("keel dev");

    for (const dep of [
      "@keel/db",
      "@keel/kernel",
      "@keel/migrate",
      "@keel/router",
      "@keel/web",
      "@keel/ui",
      "@keel/runtime",
      "react",
      "react-dom",
      "better-sqlite3",
      "zod",
    ]) {
      expect(manifest.dependencies[dep]).toBeDefined();
    }

    // The legacy @keel/orm dep is gone — scaffolded apps use @keel/db.
    expect(manifest.dependencies["@keel/orm"]).toBeUndefined();
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
    const parsed = JSON.parse(packageJson("acme")) as { name: string };

    expect(parsed.name).toBe("acme");
  });

  it("scaffolds @keel deps with resolvable specifiers, never the workspace protocol", () => {
    const parsed = JSON.parse(packageJson("acme")) as {
      dependencies: Record<string, string>;
    };

    const keelDeps = Object.entries(parsed.dependencies).filter(([name]) =>
      name.startsWith("@keel/"),
    );

    // There ARE @keel deps to check (guards against a vacuous pass).
    expect(keelDeps.length).toBeGreaterThan(0);

    for (const [, specifier] of keelDeps) {
      // `workspace:*` resolves only inside this monorepo; a scaffolded app would
      // fail to install. Every @keel dep must carry a real, resolvable specifier.
      expect(specifier).not.toContain("workspace:");
      expect(specifier).toBe("latest");
    }
  });

  it("keelApp default-exports an AppConfig", () => {
    expect(keelApp()).toContain("export default config");
  });

  it("tsconfig is bundler-resolution, strict JSON", () => {
    const parsed = JSON.parse(tsconfig()) as {
      compilerOptions: { moduleResolution: string; strict: boolean };
    };

    expect(parsed.compilerOptions.moduleResolution).toBe("Bundler");
    expect(parsed.compilerOptions.strict).toBe(true);
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
