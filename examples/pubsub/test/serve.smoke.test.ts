/**
 * The BEHAVIORAL half of `serve.ts`: does the fan-out app actually BOOT and fan a
 * message out over a REAL WebSocket? The in-process test (`pubsub.test.ts`) drives
 * the app with fake sockets; none proves `serve.ts` spawns a Bun server that
 * terminates a real socket and delivers to it. This does — a real subscriber
 * receives a fresh nonce published by a SEPARATE HTTP request.
 *
 * Modeled on `examples/cache/test/serve.smoke.test.ts`: spawn the entry under Bun
 * with `PORT=0` (the OS assigns a guaranteed-free ephemeral port — never a WHATWG
 * fetch-blocked port, never a squatter), read the port back off the `listening on
 * http://127.0.0.1:<port>` line, drive it, then SIGTERM and await a clean exit.
 * Both child streams are drained the instant the child spawns (an unread `pipe`
 * backpressure-stalls a chatty server — the undrained-child trap).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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

/** Resolve once the socket opens; reject if it errors first. */
function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("WebSocket failed to open")));
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

describe("@lesto/pubsub example — serve.ts fans out over a real WebSocket", () => {
  it("delivers a published nonce to a live WS subscriber and exits 0 on SIGTERM", async () => {
    child = spawn("bun", ["run", "serve.ts"], {
      cwd: exampleDir,
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    closed = collect(child);

    const base = await waitForListening(closed, child, 20_000);
    const wsUrl = `${base.replace(/^http/, "ws")}/subscribe?channel=smoke`;
    const nonce = randomUUID();

    const ws = new WebSocket(wsUrl);

    // Attach the receipt listener BEFORE publishing so no frame can be missed.
    const received = new Promise<FrameShape>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("subscriber never received the published nonce")),
        10_000,
      );

      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String((event as MessageEvent).data)) as FrameShape;

        if (frame.data?.nonce === nonce) {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });

    await opened(ws);

    const res = await fetch(`${base}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "smoke", message: { nonce } }),
    });

    expect(res.status).toBe(200);

    const frame = await received;

    expect(frame.channel).toBe("smoke");
    expect(frame.type).toBe("message");

    ws.close();
    child.kill("SIGTERM");

    const result = await closed;

    expect(result.code, result.stderr).toBe(0);
  }, 30_000);
});

interface FrameShape {
  type: string;
  channel: string;
  seq: number;
  data: { nonce?: string };
}
