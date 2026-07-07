/**
 * The BEHAVIORAL half of `serve.ts`: does the forms app actually BOOT and SERVE
 * over a real socket? The other tests drive the app in-process (`app.handle`) —
 * none proves the `serve.ts` entry spawns a `node:http` server that answers a
 * real `fetch()`. This does.
 *
 * Modeled on the repo's proven spawn-boot-fetch-SIGTERM shape
 * (`packages/cli/test/bin.e2e.test.ts`): spawn the entry under Bun with
 * `PORT=0`, read the OS-assigned port back off the `listening on
 * http://127.0.0.1:<port>` line it logs, `fetch()` a known route, assert a real
 * response, then SIGTERM and await a clean exit.
 *
 * Port safety WITHOUT a fixed port + probe: `PORT=0` makes the OS assign a
 * guaranteed-free EPHEMERAL port. An ephemeral port is never on the WHATWG
 * fetch-blocked list (so no "bad port" pre-connect refusal — the restricted-port
 * trap) and is never already in use (so no squatter — the squatter-port trap).
 *
 * `spawnDev` (packages/e2e/dev-harness.ts) is deliberately NOT reused: it is
 * hardcoded to launch `bun <bin> dev`, not `bun run serve.ts`, and importing
 * from `packages/e2e` into an example would drag a file outside this example's
 * tsconfig `rootDir` (TS6059) and add an undeclared cross-package dep. So this
 * mirrors Model A's small self-contained `collect`/`waitForListening` helpers.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "..");

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Attach data listeners to BOTH child streams the instant it spawns (an unread
 * `pipe` stream backpressure-stalls a chatty server — the undrained-child trap),
 * and resolve the collected output when the child finally closes.
 */
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
 * Poll the server's stdout for its `listening on http://127.0.0.1:<port>` line
 * and resolve the base URL. Fails fast (rather than hanging to the test timeout)
 * if the child dies — or fails to spawn — before it ever listens.
 */
function waitForListening(
  closed: Promise<SpawnResult>,
  child: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/;

  return new Promise((resolve, reject) => {
    let buffer = "";

    const timer = setTimeout(() => {
      reject(
        new Error(`server never printed a listening URL within ${timeoutMs}ms; saw: ${buffer}`),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");

      const found = buffer.match(match);

      if (found) {
        clearTimeout(timer);
        resolve(found[1] ?? "");
      }
    });

    void closed.then(
      (result): void => {
        clearTimeout(timer);
        reject(
          new Error(`server exited before it listened (code ${result.code}): ${result.stderr}`),
        );

        return undefined;
      },
      (error: unknown): void => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));

        return undefined;
      },
    );
  });
}

let child: ChildProcess | undefined;
let closed: Promise<SpawnResult> | undefined;

afterAll(async () => {
  // Safety net: if the test threw before its own SIGTERM, never leak the child.
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await closed;
  }
});

describe("@lesto/forms example — serve.ts boots over real HTTP", () => {
  it("serves the rendered signup form on GET /signup over a real socket and exits 0 on SIGTERM", async () => {
    child = spawn("bun", ["run", "serve.ts"], {
      cwd: exampleDir,
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    closed = collect(child);

    const base = await waitForListening(closed, child, 20_000);

    // The schema-driven form, rendered to HTML over a real HTTP round-trip (not
    // the in-process `handle` the other tests use). Assert the actual `<form>`
    // and its submit label rendered — not merely that some 200 came back.
    const res = await fetch(`${base}/signup`);

    expect(res.status).toBe(200);

    const html = await res.text();

    expect(html).toContain("<form");
    expect(html).toContain('action="/signup"');
    expect(html).toContain("Create account");

    child.kill("SIGTERM");

    const result = await closed;

    // serveWithGracefulShutdown drains then exit(0) on SIGTERM — a non-zero code
    // (or a raw signal death) means the graceful teardown regressed.
    expect(result.code, result.stderr).toBe(0);
  }, 30_000);
});
