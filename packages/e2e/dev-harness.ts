import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";

/**
 * Shared dev-server harness for the browser E2E specs.
 *
 * `waitForServer` was copy-pasted across eight specs, and two of them grew DIVERGENT 3-arg
 * signatures the same week — one appending captured dev output to its timeout error
 * (`scaffold-real-install`), one failing fast when its own child died first (`live-capstone-opfs`).
 * This module carries BOTH needs as OPTIONAL fields on one options object, so neither caller
 * forces a mode flag, and adopts the hardened readiness behaviour (any-response, per-attempt
 * abort, `Sec-Fetch-Site` header) for every caller.
 *
 * `spawnDev` additionally probes the fixed port BEFORE spawning (see {@link assertPortAvailable}) so
 * a dev server leaked by a prior crashed run can't be silently adopted as a false-green.
 */

/**
 * The ports a WHATWG-`fetch` client (Node/Bun's undici, AND Chromium's `page.goto`) refuses to
 * connect to — the "bad port" / restricted-ports list (`fetch` spec §"port blocking").
 *
 * A `fetch()` at one of these throws `TypeError: fetch failed` with `cause: Error("bad port")`
 * BEFORE any TCP connection, and a browser reports `ERR_UNSAFE_PORT`. curl and `node:http` do NOT
 * implement the list, so they connect fine. That asymmetry cost this repo days: the scaffold-real
 * leg-(a) harness booted `lesto dev` on **4190** (the ManageSieve port, on this list) and probed it
 * with {@link waitForServer}'s undici `fetch()`, which can NEVER succeed there — every attempt
 * rejected in ~3ms with "bad port", so the leg looked like a hoisted-Linux first-request HANG and was
 * root-caused, at length, to a nonexistent HTTP response-framing defect (L-513dd8a6). The dev server
 * was fine all along; the port was unfetchable. `curl`/`node:http` probes greened on the same server
 * (they ignore the list) and read as FALSE ORACLES, while a sibling harness on 4192 greened under the
 * SAME undici client — so the variable was never the linker or the closure, only the port.
 *
 * We guard against it at the source ({@link assertFetchablePort}, called by {@link spawnDev}) so a spec
 * that picks a blocked dev port fails IMMEDIATELY with a precise message instead of a silent 60s+
 * "never answered". The list is the fixed set from the fetch spec.
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);

/**
 * Throw if `port` is one an undici `fetch()` / a browser will refuse to connect to (see
 * {@link FETCH_BLOCKED_PORTS}) — a permanent, fail-fast condition, never "still booting".
 *
 * Called before spawn ({@link spawnDev}) so choosing a blocked dev port is a LOUD, immediate error
 * naming the port and the list — not a mysterious full-deadline timeout that reads as a product hang.
 */
export function assertFetchablePort(port: number): void {
  if (FETCH_BLOCKED_PORTS.has(port)) {
    throw new Error(
      `dev port ${port} is on the WHATWG fetch restricted-ports list, so an undici \`fetch()\` (and a ` +
        `browser \`page.goto\`) will refuse it with "bad port" BEFORE connecting — the server can never ` +
        `be reached by this harness. Choose a port NOT in FETCH_BLOCKED_PORTS (dev-harness.ts). ` +
        `This is the L-513dd8a6 trap: port 4190 masqueraded as a hoisted-Linux dev hang for days.`,
    );
  }
}

/** True iff `error` is the undici "bad port" rejection (a fetch at a {@link FETCH_BLOCKED_PORTS} port). */
function isBadPortError(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | undefined)?.cause;

  return cause instanceof Error && cause.message === "bad port";
}

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
    } catch (error) {
      // A "bad port" reject is PERMANENT — the URL's port is on the fetch restricted-ports list, so
      // no amount of retrying will ever connect (this is the L-513dd8a6 trap: port 4190 fetch loop
      // ran 300 instant rejects and read as a 300s "hang"). Fail fast and loud instead of burning the
      // whole deadline and blaming the server. Every OTHER reject (connection refused / reset /
      // per-attempt abort) is "not up yet" — keep polling.
      if (isBadPortError(error)) {
        const port = new URL(url).port;

        throw new Error(
          `${url} uses port ${port}, which is on the WHATWG fetch restricted-ports list — an undici ` +
            `\`fetch()\` refuses it with "bad port" before connecting, so the server can NEVER be ` +
            `reached here regardless of whether it is up. Pick a port not in FETCH_BLOCKED_PORTS.`,
          { cause: error },
        );
      }
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

/**
 * A spawned `lesto dev` child plus a reader for its captured (drained) stdout+stderr.
 *
 * Extends {@link WaitForServerOptions} — it structurally supersets it: `output` and `hasExited` are
 * exactly the two hooks {@link waitForServer} reads, so a `DevProcess` can be handed straight to it
 * (`waitForServer(url, ms, devProc)`) instead of re-spelling `{ output: devProc.output, hasExited:
 * devProc.hasExited }` at every call site. Declaring the `extends` makes that intent explicit and
 * makes it structurally impossible to wire `output` but forget `hasExited`: both are REQUIRED here,
 * narrowing the base interface's optionals.
 */
export interface DevProcess extends WaitForServerOptions {
  child: ChildProcess;
  output: () => string;
  /**
   * `true` once the child has exited OR failed to spawn — feeds {@link WaitForServerOptions.hasExited}
   * so a spec on a fixed port fails fast on a dead child instead of polling a corpse for the full
   * timeout. Reflects real state (flipped by the `exit`/`error` listeners), never a constant.
   *
   * Does NOT itself defend against a live SQUATTER (a dev server leaked by a prior crashed run,
   * already answering the fixed port): the first probe would succeed against it and `waitForServer`
   * would return BEFORE our own child's EADDRINUSE death flips this flag. That case is closed
   * separately, at the source, by {@link spawnDev}'s pre-spawn {@link assertPortAvailable} probe
   * (L-b5186728). This flag remains for the complementary case it does cover: OUR OWN child dying
   * at (or after) boot without ever answering.
   */
  hasExited: () => boolean;
}

/**
 * Throw if anything is ALREADY answering `port` before we spawn our own dev server on it — the real
 * closure of the live-squatter false-green (L-b5186728).
 *
 * A `lesto dev` leaked by a prior crashed run — or this suite's OWN previous attempt still dying — stays
 * LISTENING on a fixed port (the specs pin fixed ports in the 4187-4199 range). Our new child hasn't
 * bound yet, so {@link waitForServer}'s first fetch answers against the SQUATTER and returns green —
 * against STALE code — ~500ms BEFORE our own child hits EADDRINUSE, dies, and flips
 * {@link DevProcess.hasExited} (which nothing re-reads after the green return). So `hasExited` only
 * narrows a LATE-appearing squatter; probing the port BEFORE spawn closes the already-listening case
 * deterministically. A page-swap / island-fast-refresh spec is otherwise a silent false-green when a
 * leaked prior dev serves the same examples dir.
 *
 * Classification (loopback makes this crisp): a genuinely-free loopback port refuses the connection
 * INSTANTLY (kernel RST → the fetch rejects long before the 2s timer), so ONLY a refused/reset reject
 * means "free". An actual HTTP response OR a FIRED timeout (something accepted the connection but
 * stalled — a wedged/cold squatter) both mean "occupied", and both throw. Unlike {@link waitForServer},
 * which RETRIES on a per-attempt timeout, this one-shot probe fails CLOSED on it: treating a stalled
 * acceptor as free would spawn into an EADDRINUSE and hand the slow-squatter race straight back. The
 * happy path (free port) is instant.
 *
 * @param origin The base URL to probe (default `http://127.0.0.1:${port}`). Callers pass the SAME origin
 * they'll later poll with {@link waitForServer}, so probe-addr == adoption-addr: today every fixed-port
 * spec pins `127.0.0.1`, but a spec polling `localhost` resolves to `::1`, and a `::1`-only squatter a
 * `127.0.0.1` probe never saw would be adopted as a false-green (the repo already ate a localhost/::1
 * mismatch, L-2d87f1b5). MUST be a loopback origin for the instant-refuse classification above to hold.
 */
export async function assertPortAvailable(
  port: number,
  origin = `http://127.0.0.1:${port}`,
): Promise<void> {
  // Own the signal so we can tell a fired timeout (stalled acceptor → occupied) from a fast connection
  // reject (refused/reset → free) portably, without inspecting undici/bun-specific error shapes.
  const signal = AbortSignal.timeout(2_000);

  try {
    // Any HTTP response — even non-2xx — means SOMETHING is already serving this port. `redirect:
    // "manual"` so a squatter answering a 3xx still counts as answering, rather than chasing it to a
    // possibly-dead target whose reject we'd misread as a free port.
    await fetch(`${origin}/`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
      redirect: "manual",
      signal,
    });
  } catch {
    if (signal.aborted) {
      throw new Error(
        `port ${port} accepted a connection but sent no response within 2s before spawn — a wedged ` +
          `dev server (this suite's own prior attempt, or a prior run) is holding it. ` +
          `Kill it (e.g. \`lsof -ti :${port} | xargs kill\`) and retry.`,
      );
    }

    return; // connection refused/reset (not a timeout) — the port is ours to bind
  }

  throw new Error(
    `port ${port} already answering before spawn — a dev server (this suite's own prior attempt, or a ` +
      `prior crashed run) is holding it. Kill it (e.g. \`lsof -ti :${port} | xargs kill\`) and retry.`,
  );
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
 *
 * `origin` (default `http://127.0.0.1:${port}`) is forwarded to the pre-spawn probe so it checks the SAME
 * address the caller will poll — see {@link assertPortAvailable}. All callers pin `127.0.0.1` today; the
 * seam exists so a future `localhost` spec probes `::1` rather than a mismatched `127.0.0.1`.
 */
export async function spawnDev(
  bin: string,
  appDir: string,
  port: number,
  origin = `http://127.0.0.1:${port}`,
): Promise<DevProcess> {
  // First: refuse a port an undici `fetch()` / browser can never reach (L-513dd8a6). A blocked port
  // (e.g. 4190) makes `waitForServer` and `page.goto` fail with "bad port" — booting here would produce
  // a full-deadline "never answered" that reads as a product hang. Fail LOUD at spawn instead. This runs
  // before `assertPortAvailable` because that probe's own `fetch` misreads a "bad port" reject as a free
  // port (it looks like a connection-refused reject), so it would wave a blocked port straight through.
  assertFetchablePort(port);

  // Then: close the live-squatter false-green (L-b5186728) at the source: if a dev server leaked by a
  // prior crashed run is ALREADY answering this fixed port, waitForServer's first probe would adopt it and
  // return green against STALE code, well before our own child's EADDRINUSE death flips `hasExited`.
  // Probe BEFORE spawn so the boot fails loud instead of silently serving a prior run. See
  // {@link assertPortAvailable}.
  await assertPortAvailable(port, origin);

  const child = spawn("bun", [bin, "dev", "--port", String(port)], {
    cwd: appDir,
    stdio: "pipe",
  });

  let buffer = "";
  let exited = false;
  const capture = (chunk: Buffer): void => {
    buffer += chunk.toString();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  // Record the exit code/signal IF the child ever dies — otherwise invisible — and flip `exited` so
  // callers can fail fast via `hasExited`. NOTE: a live-but-"unreachable" dev on a fixed port is more
  // often a HARNESS fault than a product one — the published-0.1.2 leg (a) "hang" was really the
  // fetch-blocked port 4190 (`assertFetchablePort` now catches that class at spawn); this listener
  // stays for the genuine case it covers: OUR OWN child dying at/after boot without ever answering.
  child.on("exit", (code, signal) => {
    exited = true;
    buffer += `\n[lesto dev exited code=${code ?? "null"} signal=${signal ?? "null"}]`;
  });
  // A spawn-level failure (ENOENT `bun`, EMFILE on a loaded runner) emits `error` and NEVER `exit`.
  // Without this listener the ChildProcess EventEmitter would throw ERR_UNHANDLED_ERROR and crash the
  // Playwright worker, and `exited` would stay false — so waitForServer would poll a process that was
  // never alive. Flip the same flag so the boot failure surfaces fast, with its cause named.
  child.on("error", (err) => {
    exited = true;
    buffer += `\n[lesto dev spawn error: ${err.message}]`;
  });

  return { child, output: () => buffer, hasExited: () => exited };
}

/**
 * SIGTERM a dev child and AWAIT its exit, bounded — the teardown counterpart to {@link spawnDev}'s
 * pre-spawn probe (L-2a28bde6).
 *
 * The fixed-port specs pin a port, and on CI (`retries: 1`, serial) Playwright reruns a failed file in a
 * FRESH worker. A fire-and-forget `child.kill("SIGTERM")` in `afterAll` returns the instant the signal is
 * QUEUED — not when the child has unlistened — so the retry's `beforeAll` can call {@link assertPortAvailable}
 * on the same port while the dying prior attempt is still bound, and the probe throws (fails SAFE — a RED,
 * not a false-green — but it BURNS the one retry that absorbs real flakes). Awaiting the child's actual
 * `exit` here closes that window: the port is released before this resolves and the next attempt binds.
 *
 * A busy event loop (Vite dep-optimize / bun transpile) can delay the child's SIGTERM handler by seconds
 * — and the CLI's shutdown sets no force-exit deadline — so the wait is bounded by `graceMs`; if the child
 * hasn't exited by then we escalate to an uncatchable SIGKILL and await THAT, so `afterAll` can neither
 * hang the run nor leave the port held. Null-safe and idempotent: a nullish or already-exited child returns
 * at once (attaching `once(child, "exit")` after exit already fired would await an event that never comes).
 */
export async function killAndWait(child: ChildProcess | undefined, graceMs = 5_000): Promise<void> {
  // Nothing to wait on — return at once, because each case would otherwise hang the `await` below on an
  // `exit` that never comes: no child; a child that never spawned (a spawn `error` fires but no `exit`,
  // and `exitCode`/`signalCode` stay null, so `pid === undefined` is the only tell); or one that already
  // exited (`exitCode`/`signalCode` set, so `once(…,"exit")` would await an event that already passed).
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  // Resolve on the child's real `exit`. `.catch` keeps this TOTAL: a teardown-time `error` event must not
  // reject out of killAndWait and skip the caller's own afterAll cleanup (restoring an edited source file,
  // rm-ing a temp workspace) — guarantees the old fire-and-forget `kill` upheld for free because it could
  // not throw. Attach BEFORE signalling so a child that dies instantly can't fire `exit` in the gap.
  const exited = once(child, "exit").catch(() => {});
  child.kill("SIGTERM");

  // Escalate to an uncatchable SIGKILL if SIGTERM is starved past the grace window — a busy event loop
  // (Vite dep-optimize / bun transpile), and the CLI sets no force-exit deadline. The single `await exited`
  // resolves whether death came from the SIGTERM or this SIGKILL, so the port is always free before we
  // return; the timer is cleared synchronously in `finally` the instant the child exits, so a fast SIGTERM
  // leaves no pending SIGKILL to hit a PID the OS may have recycled.
  const killer = setTimeout(() => child.kill("SIGKILL"), graceMs);

  try {
    await exited;
  } finally {
    clearTimeout(killer);
  }
}
