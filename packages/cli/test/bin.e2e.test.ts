import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
});
