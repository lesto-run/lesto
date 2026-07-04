import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/**
 * Shared dev-server harness for the browser E2E specs.
 *
 * `waitForServer` was copy-pasted across eight specs, and two of them grew DIVERGENT 3-arg
 * signatures the same week — one appending captured dev output to its timeout error
 * (`scaffold-real-install`), one failing fast when its own child died first (`live-capstone-opfs`).
 * This module carries BOTH needs as OPTIONAL fields on one options object, so neither caller
 * forces a mode flag, and adopts the hardened readiness behaviour (any-response, per-attempt
 * abort, `Sec-Fetch-Site` header) for every caller.
 */

/** Optional hardening hooks for {@link waitForServer}; both independently optional. */
export interface WaitForServerOptions {
  /** Fail fast if OUR OWN child died before answering (avoids adopting a stale/foreign server on a fixed port). */
  hasExited?: () => boolean;
  /** Captured dev-server output, appended to the timeout error so a boot failure names its cause. */
  output?: () => string;
}

/** Poll the dev server until it answers, or time out — naming the captured dev output on failure. */
export async function waitForServer(
  url: string,
  timeoutMs: number,
  opts?: WaitForServerOptions,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // If our own child already exited, stop at once rather than polling a dead (or worse, a
    // stale/foreign) server on the fixed port until the deadline. No-op unless a caller wires it.
    if (opts?.hasExited?.() === true) {
      throw new Error(`server process exited before answering ${url}`);
    }

    try {
      // Any HTTP response — even a non-2xx — means the server is UP and answering; the per-test
      // `page.goto` assertions are what validate the actual response. Requiring 2xx here turned a
      // reachable server whose `/` is non-2xx into an opaque 60s timeout instead of a real failure.
      // A per-attempt abort bounds the "accepts TCP but never sends headers" case: without it undici's
      // ~300s headers timeout outruns the deadline, and the diagnostic-bearing throw below never runs.
      await fetch(url, {
        headers: { "Sec-Fetch-Site": "same-origin" },
        signal: AbortSignal.timeout(2_000),
      });

      return;
    } catch {
      // not up yet (connection refused / reset / per-attempt abort)
    }

    if (Date.now() > deadline) {
      const tail = opts?.output?.().trim();

      throw new Error(
        `dev server never answered at ${url}` +
          (tail ? `\n--- dev output ---\n${tail}` : " (no dev output was captured)"),
      );
    }

    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Run a command to completion, rejecting on a non-zero exit (captures stderr for the message). */
export function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "pipe" });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    // Drain stdout too: an unread `stdio: "pipe"` stream can fill the OS pipe buffer and BLOCK a
    // chatty child (a real `bun install` / `lesto build`) — the same stall that faked a leg failure.
    child.stdout?.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();

        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr}`));
    });
  });
}

/** A spawned `lesto dev` child plus a reader for its captured (drained) stdout+stderr. */
export interface DevProcess {
  child: ChildProcess;
  output: () => string;
}

/**
 * Boot `lesto dev` (`bun <bin> dev --port <port>`), capturing its stdout+stderr into an (unbounded)
 * buffer. An unread `stdio: "pipe"` stream does not just lose the output — it BACKPRESSURE-BLOCKS the
 * child once the OS pipe fills, the stall that faked "won't hydrate" (ccdc936). Draining also lets
 * {@link waitForServer} append the captured output to its timeout error, so a boot failure names its
 * cause instead of being opaque.
 *
 * `bin` is passed in because specs resolve the `lesto` bin differently: `scaffold-real-install` runs
 * the app's OWN installed shim (`node_modules/.bin/lesto`), the others run the in-repo `packages/cli/src/bin.ts`.
 */
export function spawnDev(bin: string, appDir: string, port: number): DevProcess {
  const child = spawn("bun", [bin, "dev", "--port", String(port)], {
    cwd: appDir,
    stdio: "pipe",
  });

  let buffer = "";
  const capture = (chunk: Buffer): void => {
    buffer += chunk.toString();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  // Record the exit code/signal IF the child ever dies — otherwise invisible. NOTE: published 0.1.1's
  // dev does NOT exit; it stays alive but unreachable on CI (this listener never fired — the evidence
  // that refuted a presumed death), so leg (a)'s dev boot is version-skipped. See scaffold-real-install.
  child.on("exit", (code, signal) => {
    buffer += `\n[lesto dev exited code=${code ?? "null"} signal=${signal ?? "null"}]`;
  });

  return { child, output: () => buffer };
}
