import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The `lesto` bin, end to end as a REAL spawned process (operability-dx #6).
 *
 * `run.ts` is unit-covered to 100%, but the bin itself is excluded from coverage:
 * it is the wiring — the shebang, `process.argv`, the dynamic `import()` of the
 * project's `lesto.app.ts` / `lesto.sites.ts`, the SIGTERM/SIGINT shutdown handlers,
 * and the `process.exit(code)`. That wiring is exactly where a working loop breaks
 * silently: a dynamic import that throws, a signal handler that never drains, an
 * exit code that lies. A unit test cannot see any of it because none of it runs
 * in-process. So this suite SPAWNS the bin under Bun against the fixture project
 * and drives every command at least once over a real process boundary:
 *
 *   - `routes`            — loads `lesto.app.ts`, prints routes, exits 0
 *   - `serve`            — boots over HTTP, answers a request, exits 0 on SIGTERM
 *   - `dev`              — boots every site live, answers a request, exits 0 on SIGTERM
 *   - `deploy --release` — prerenders + ships a versioned release, exits 0
 *   - `rollback --to`    — flips the live pointer to a prior release, exits 0
 *
 * No shell: every argument is an array element, so nothing is interpolated into a
 * command string. Build artifacts (`--out` / `--dist`) are redirected to a temp
 * dir so a spawned `deploy` never writes into the repo tree.
 */

const here = dirname(fileURLToPath(import.meta.url));

const binPath = join(here, "..", "src", "bin.ts");
const fixtureDir = join(here, "fixture");

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Collect a child's stdout/stderr into a result, resolving on close. */
function collect(child: ChildProcess): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/**
 * Spawn the real bin under Bun against the fixture project and run it to
 * completion. The fixture root carries a `lesto.app.ts` (+ a `lesto.sites.ts`),
 * loaded by the bin's dynamic import — exactly as a real project root would.
 */
function runBin(args: readonly string[]): Promise<SpawnResult> {
  return collect(spawn("bun", [binPath, ...args], { cwd: fixtureDir }));
}

/**
 * Spawn the real bin against an ARBITRARY cwd — used by `generate agents`, which
 * writes `AGENTS.md` / `llms.txt` into the cwd (no `--out` redirect), so its e2e
 * must run inside a throwaway temp project rather than the committed fixture dir.
 */
function runBinIn(cwd: string, args: readonly string[]): Promise<SpawnResult> {
  return collect(spawn("bun", [binPath, ...args], { cwd }));
}

/**
 * A gitignored scratch root INSIDE the repo tree (`packages/cli/.out/`, ignored via
 * the root `.gitignore` `.out/` rule) for temp projects whose own files import the
 * workspace packages (`@lesto/content-core`, `@lesto/web`, `zod`, …). A project under
 * `os.tmpdir()` cannot resolve those bare specifiers — Node/Bun walk UP from the
 * importer to find `node_modules`, and a `/tmp` dir has no parent `node_modules` — so a
 * `lesto.content.ts` (Task 2) or a copied buildable fixture (Task 3) MUST live within the
 * repo to resolve them. `os.tmpdir()` still fits the convention-scan-only projects above
 * (`generate agents` never imports the project's modules — it scans the dir structure).
 */
const inRepoTmpRoot = join(here, "..", ".out", "e2e");

/** Make a unique temp project dir inside the repo scratch root (parents created). */
async function mkdtempInRepo(prefix: string): Promise<string> {
  await mkdir(inRepoTmpRoot, { recursive: true });

  return mkdtemp(join(inRepoTmpRoot, prefix));
}

/**
 * Spawn a long-running command (`serve` / `dev`), returning the live child and a
 * promise that resolves when it finally closes — so a test can boot it, hit it,
 * then SIGTERM it and assert it drained to a clean exit.
 */
function startBin(args: readonly string[]): { child: ChildProcess; closed: Promise<SpawnResult> } {
  const child = spawn("bun", [binPath, ...args], { cwd: fixtureDir });

  return { child, closed: collect(child) };
}

/** Poll a server's stdout for its "listening" line, then resolve its base URL. */
function waitForLine(
  closed: Promise<SpawnResult>,
  child: ChildProcess,
  match: RegExp,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const timer = setTimeout(() => {
      reject(new Error(`server never printed ${String(match)}; saw: ${buffer}`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");

      const found = buffer.match(match);

      if (found) {
        clearTimeout(timer);
        resolve(found[1] ?? "");
      }
    });

    // If the process dies before it listens, fail fast rather than hang.
    void closed.then((result): void => {
      clearTimeout(timer);
      reject(new Error(`server exited before listening (code ${result.code}): ${result.stderr}`));

      return undefined;
    });
  });
}

let workspace: string;

beforeAll(async () => {
  // A private temp root for every build artifact, so a spawned `deploy`/`build`
  // writes its `out/` and `dist/` here, never into the repo's fixture dir.
  workspace = await mkdtemp(join(tmpdir(), "lesto-cli-e2e-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("bin e2e", () => {
  it("routes: loads the project's lesto.app.ts and prints its routes, exiting 0", async () => {
    const result = await runBin(["routes"]);

    expect(result.code, result.stderr).toBe(0);

    // The fixture's `lesto()` app declares these routes; `routes` prints the
    // code-first `method\tpattern` shape (no controller#action target).
    expect(result.stdout).toContain("GET\t/posts");
    expect(result.stdout).toContain("POST\t/posts");
    expect(result.stdout).toContain("GET\t/posts/:id");

    // ...AND the file routes the CLI auto-discovered under `app/routes/` — proving
    // the real fs scan + per-file `import()` + apply wiring (the impure seam the
    // unit tests inject a fake into). `/` is the named-export root page;
    // `/blog/:slug` is a nested `[slug]` dynamic segment.
    expect(result.stdout).toContain("GET\t/");
    expect(result.stdout).toContain("GET\t/blog/:slug");
  }, 30_000);

  it("serve: boots over HTTP, answers a request, and exits 0 on SIGTERM", async () => {
    const { child, closed } = startBin(["serve", "--port", "0"]);

    try {
      // The bin prints `listening on http://127.0.0.1:<port>` once the socket is up.
      const base = await waitForLine(
        closed,
        child,
        /listening on (http:\/\/127\.0\.0\.1:\d+)/,
        30_000,
      );

      const response = await fetch(`${base}/posts`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ posts: [] });
    } finally {
      child.kill("SIGTERM");
    }

    // The SIGTERM handler drains the server and exits 0 — the rolling-restart
    // contract. A non-zero exit (or a kill by signal) would mean the handler
    // never ran or the drain threw.
    const result = await closed;

    expect(result.code, result.stderr).toBe(0);
  }, 30_000);

  it("dev: boots every site live, answers a request, and exits 0 on SIGTERM", async () => {
    const { child, closed } = startBin(["dev", "--port", "0"]);

    try {
      const base = await waitForLine(
        closed,
        child,
        /dev server on (http:\/\/127\.0\.0\.1:\d+)/,
        30_000,
      );

      // dev dispatches live through the app; `Sec-Fetch-Site` keeps the same-origin
      // dev request off the CSRF path.
      const response = await fetch(`${base}/posts`, {
        headers: { "Sec-Fetch-Site": "same-origin" },
      });

      expect(response.status).toBe(200);

      // Workstream 3: a file-route HTML page carries the injected live-reload client
      // script (a WebSocket connector). This exercises the real bin wiring end to
      // end — buildLiveReload's script + the dev handle's HTML injection.
      const pageResponse = await fetch(`${base}/`, {
        headers: { "Sec-Fetch-Site": "same-origin" },
      });
      const html = await pageResponse.text();

      expect(pageResponse.status).toBe(200);
      expect(html).toContain("new WebSocket(");
      // ...AND the injected client is the dev ERROR-OVERLAY client (dev-overlay.ts),
      // not a bare reloader: the booted bin ships the overlay renderer, so a pushed
      // build/reload failure paints `#__lesto_dev_overlay__` in the page.
      expect(html).toContain("__lesto_dev_overlay__");
    } finally {
      child.kill("SIGTERM");
    }

    const result = await closed;

    expect(result.code, result.stderr).toBe(0);
  }, 30_000);

  it("deploy --release then rollback: ships a versioned release and flips back, each exiting 0", async () => {
    const out = join(workspace, "out");
    const dist = join(workspace, "dist");

    // Ship v1: prerender the fixture's static `/posts` site into a versioned
    // `releases/v1/` tree and flip the `current` pointer to it.
    const v1 = await runBin([
      "deploy",
      "--release",
      "--version",
      "v1",
      "--out",
      out,
      "--dist",
      dist,
    ]);

    expect(v1.code, v1.stderr).toBe(0);
    expect(v1.stdout).toContain("released app: 1 route (version v1)");
    expect(v1.stdout).toContain("current → v1");

    // Ship v2 the same way; the pointer now flips to v2.
    const v2 = await runBin([
      "deploy",
      "--release",
      "--version",
      "v2",
      "--out",
      out,
      "--dist",
      dist,
    ]);

    expect(v2.code, v2.stderr).toBe(0);
    expect(v2.stdout).toContain("current → v2");

    // Roll back to v1: the same atomic pointer flip a deploy ends with, in reverse.
    const back = await runBin(["rollback", "--to", "v1", "--dist", dist]);

    expect(back.code, back.stderr).toBe(0);
    expect(back.stdout).toContain("rolled back: v2 → v1");
  }, 60_000);

  it("generate agents: scans the app's conventions into AGENTS.md + llms.txt, and --check passes when fresh", async () => {
    // A throwaway project TREE: file routes + an island. `generate agents` reads the
    // directory STRUCTURE (it never imports these modules — routes compile from the
    // scan, islands glob by basename), so stub bodies are enough to drive the real
    // fs scan + glob wiring the unit tests inject fakes for. Run in its own temp dir
    // because the artifacts are written cwd-relative, with no `--out` redirect.
    const project = await mkdtemp(join(tmpdir(), "lesto-agents-e2e-"));

    try {
      await mkdir(join(project, "app", "routes", "blog", "[slug]"), { recursive: true });
      await mkdir(join(project, "app", "islands"), { recursive: true });
      await writeFile(join(project, "app", "routes", "page.tsx"), "export default {};\n");
      await writeFile(
        join(project, "app", "routes", "blog", "[slug]", "page.tsx"),
        "export default {};\n",
      );

      // Two GENUINE islands plus one of every excluded sibling — the bin's island
      // filter (`readAgentIslands`) lives in coverage-excluded `bin.ts`, so this e2e
      // is the only thing that can prove its exclusion arms (hidden, `.d.ts`,
      // `.test`/`.spec`, non-island extension). A regression that surfaced any of the
      // siblings as a phantom island would otherwise ship green.
      await writeFile(join(project, "app", "islands", "counter.tsx"), "export default {};\n");
      await writeFile(join(project, "app", "islands", "widget.tsx"), "export default {};\n");
      await writeFile(join(project, "app", "islands", "counter.test.tsx"), "export default {};\n");
      await writeFile(join(project, "app", "islands", "button.d.ts"), "export type B = 1;\n");
      await writeFile(join(project, "app", "islands", ".hidden.tsx"), "export default {};\n");
      await writeFile(join(project, "app", "islands", "README.md"), "# notes\n");

      const gen = await runBinIn(project, ["generate", "agents"]);

      expect(gen.code, gen.stderr).toBe(0);
      expect(gen.stdout).toContain("wrote AGENTS.md");
      expect(gen.stdout).toContain("wrote llms.txt");

      // The benign collections degrade (content-core present in the workspace, but its
      // runtime store is uninitialized at doc-gen time) is now SILENT — the warning is
      // reserved for a genuine breakage, so it must not appear on this ordinary run.
      expect(gen.stderr).not.toContain("content collections unavailable");

      const agentsMd = await readFile(join(project, "AGENTS.md"), "utf8");
      const llmsTxt = await readFile(join(project, "llms.txt"), "utf8");

      // The route compiled from the real `app/routes/blog/[slug]/` scan (the `[slug]`
      // dynamic segment → `:slug`), the globbed islands, and the CLI surface all land
      // in the generated guide — proving the bin's real readers, not a fake.
      expect(agentsMd).toContain("# Agent guide");
      expect(agentsMd).toContain("/blog/:slug");
      expect(agentsMd).toContain("counter");
      expect(agentsMd).toContain("widget");
      expect(agentsMd).toContain("generate");

      // The excluded siblings are NOT surfaced as islands (the filter held), and the
      // two real islands appear in deterministic code-point order (counter < widget).
      expect(agentsMd).not.toContain("button"); // `button.d.ts` (a type decl)
      expect(agentsMd).not.toContain("README"); // not an island module extension
      expect(agentsMd).not.toContain("hidden"); // dotfile
      expect(agentsMd).not.toContain("counter.test"); // co-located test
      expect(agentsMd.indexOf("counter")).toBeLessThan(agentsMd.indexOf("widget"));

      // The project index is the OTHER artifact, with its own distinguishing header.
      expect(llmsTxt).toContain("# Lesto app");
      expect(llmsTxt).toContain("/blog/:slug");

      // A second run via the `g` alias with --check finds the artifacts fresh and
      // exits 0 — the CI drift gate, byte-stable across runs.
      const check = await runBinIn(project, ["g", "agents", "--check"]);

      expect(check.code, check.stderr).toBe(0);
      expect(check.stdout).toContain("agent files are up to date");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 30_000);

  it("generate agents: a content-driven app lists its collection and notes programmatic routing", async () => {
    // The content-collections reader (`readContentConfig`) is coverage-excluded in the
    // bin, and the previous e2e exercises only its EMPTY branch (its temp project has no
    // `lesto.content.ts`). This project DOES carry one — plus two content files — so the
    // real wiring runs: load `lesto.content.ts`, run `@lesto/content-core`'s `runPipeline`,
    // group entries into per-collection counts. A reader-wiring regression (wrong config
    // arg, wrong grouping) would show up here as a missing/miscounted collection.
    //
    // It lives in the REPO scratch root (not `os.tmpdir()`) because `lesto.content.ts`
    // imports `@lesto/content-core` and `zod` by bare specifier, which only resolve when
    // the importer has a parent `node_modules` — i.e. inside the workspace.
    const project = await mkdtempInRepo("agents-content-");

    try {
      await mkdir(join(project, "content", "docs"), { recursive: true });

      // A content collection registered the way an app's own code does. No `app/routes/`
      // dir at all — this is the content-driven app whose pages register programmatically.
      await writeFile(
        join(project, "lesto.content.ts"),
        [
          'import { defineCollection, defineConfig } from "@lesto/content-core";',
          'import { z } from "zod";',
          "",
          "const docs = defineCollection({",
          '  name: "docs",',
          '  directory: "content/docs",',
          '  include: "**/*.md",',
          "  schema: z.object({ title: z.string() }),",
          "});",
          "",
          "export default defineConfig({ collections: [docs] });",
          "",
        ].join("\n"),
      );

      await writeFile(
        join(project, "content", "docs", "intro.md"),
        "---\ntitle: Intro\n---\n\n# Intro\n",
      );
      await writeFile(
        join(project, "content", "docs", "guide.md"),
        "---\ntitle: Guide\n---\n\n# Guide\n",
      );

      const gen = await runBinIn(project, ["generate", "agents"]);

      expect(gen.code, gen.stderr).toBe(0);
      expect(gen.stdout).toContain("wrote AGENTS.md");

      // The benign degrade warning must NOT appear — the pipeline read the real config.
      expect(gen.stderr).not.toContain("content collections unavailable");

      const agentsMd = await readFile(join(project, "AGENTS.md"), "utf8");

      // The collection is listed with the right entry count (two `.md` files → 2 entries),
      // proving the reader wired the config + grouped the run correctly.
      expect(agentsMd).toContain("## Content collections");
      expect(agentsMd).toContain("- `docs` — 2 entries");

      // Task 1: with NO file-based routes but a content collection present, the Routes
      // section is no longer the misleading bare "_None._" — it names the programmatic
      // routing model and points at the collections, without fabricating any URL pattern.
      expect(agentsMd).toContain("## Routes");
      expect(agentsMd).toContain(
        "registers its pages programmatically from its content collections",
      );
      expect(agentsMd).toContain("see the Content collections section below");
      expect(agentsMd).not.toContain("## Routes\n\n_None._");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 60_000);

  it("build: proceeds hookless when lesto.build.ts is absent, and fails loud on a syntax error in it", async () => {
    // `loadBuildHook` is coverage-excluded in the bin and only ever mocked in `run.test.ts`,
    // so this e2e is the sole guard on its import-error classification: swallow the absent
    // hook (no `lesto.build.ts` → build proceeds), but rethrow a real error inside an
    // existing one (a syntax error → loud, non-zero exit). The project is a COPY of the
    // committed fixture (a complete buildable app), placed in the repo scratch root so its
    // `@lesto/*` imports resolve.
    const project = await mkdtempInRepo("build-hook-");

    try {
      await cp(fixtureDir, project, { recursive: true });

      // (a) No `lesto.build.ts` at all → the build runs to a clean exit, hookless.
      const hookless = await runBinIn(project, ["build", "--out", "out"]);

      expect(hookless.code, hookless.stderr).toBe(0);
      expect(hookless.stdout).toContain("built app:");

      // (b) A `lesto.build.ts` that exists but has a SYNTAX ERROR must fail the build
      // loudly — a real bug must never be swallowed as "no hook".
      await writeFile(
        join(project, "lesto.build.ts"),
        "export default function ( { this is not valid typescript :::\n",
      );

      const broken = await runBinIn(project, ["build", "--out", "out"]);

      expect(broken.code).not.toBe(0);
      // The failure surfaces the offending file, not a swallowed silent success.
      expect(`${broken.stdout}${broken.stderr}`).toContain("lesto.build.ts");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 60_000);

  it("build: rejects a path-unsafe site name from a hand-built lesto.sites.ts (live-path validation)", async () => {
    // The site-name guard lives in `defineSites`, but a project can `export default [...]`
    // a hand-built `Site[]` that skips it (as `examples/tailwind` does). `loadSites` runs
    // the raw export through `defineSites`, so name validation is enforced on the live
    // build path: a `../../`-shaped name — which would re-root `cleanDir` / the build-hook
    // sink OUTSIDE the output tree — fails the build loudly instead of writing or deleting
    // outside `out/`. (Coverage-excluded `loadSites`; this e2e is the sole guard on the wiring.)
    const project = await mkdtempInRepo("sites-name-");

    try {
      await cp(fixtureDir, project, { recursive: true });
      await writeFile(
        join(project, "lesto.sites.ts"),
        'import type { Site } from "@lesto/sites";\n' +
          'const sites: Site[] = [{ name: "../../x", render: "static", basePath: "/", pages: ["/"] }];\n' +
          "export default sites;\n",
      );

      const result = await runBinIn(project, ["build", "--out", "out"]);

      expect(result.code).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("../../x");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 60_000);

  it("build: proceeds siteless when lesto.sites.ts is absent, and fails loud on a syntax error or a missing transitive import in it", async () => {
    // `loadSites`' import-error classifier is coverage-excluded in the bin (mocked in
    // `run.test.ts`), so — like the `loadBuildHook` twin above — this e2e is the sole guard
    // on the real wiring: swallow ONLY the absent sites file (→ build proceeds with no
    // sites), but rethrow a real error inside an EXISTING one — a syntax error, OR a missing
    // TRANSITIVE import — so a real bug is never masked as "no sites". The last case is the
    // absolute-path tightening: the Bun `ResolveMessage` for a missing `./missing.ts` embeds
    // the IMPORTER path (`… from '…/lesto.sites.ts'`), which a bare-suffix message match would
    // false-swallow; anchoring on the extracted specifier fails it loud. A COPY of the
    // committed fixture (a complete buildable app) in the repo scratch root, so its `@lesto/*`
    // imports resolve.
    const project = await mkdtempInRepo("sites-load-");

    try {
      await cp(fixtureDir, project, { recursive: true });

      // (a) NO `lesto.sites.ts` at all → the build runs to a clean exit, siteless (the
      // dirExists probe short-circuits; the import is never attempted — no hang, no crash).
      await rm(join(project, "lesto.sites.ts"));

      const siteless = await runBinIn(project, ["build", "--out", "out"]);

      expect(siteless.code, siteless.stderr).toBe(0);

      // (b) A `lesto.sites.ts` that exists but has a SYNTAX ERROR must fail the build loudly,
      // naming the offending file — never swallowed as "no sites".
      await writeFile(join(project, "lesto.sites.ts"), 'export default [ { name: "x" ::: \n');

      const broken = await runBinIn(project, ["build", "--out", "out"]);

      expect(broken.code).not.toBe(0);
      expect(`${broken.stdout}${broken.stderr}`).toContain("lesto.sites.ts");

      // (c) A `lesto.sites.ts` that exists but imports a MISSING TRANSITIVE module must ALSO
      // fail loud — the footgun the absolute-path tightening closes (the importer path in the
      // error message must not false-swallow it as the absent sites file).
      await writeFile(
        join(project, "lesto.sites.ts"),
        'import "./missing-transitive.ts";\n' +
          'import { defineSites } from "@lesto/sites";\n' +
          'export default defineSites([{ name: "app", render: "static", basePath: "/", pages: ["/posts"] }]);\n',
      );

      const transitive = await runBinIn(project, ["build", "--out", "out"]);

      expect(transitive.code).not.toBe(0);
      expect(`${transitive.stdout}${transitive.stderr}`).toContain("missing-transitive");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 90_000);
});
