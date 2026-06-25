#!/usr/bin/env node
/**
 * Boot the Lesto bench Worker on LOCAL workerd (Cloudflare's runtime), honoring the
 * driver's PORT env — the edge tier's load path.
 *
 * Local workerd is the ONLY honest throughput comparison for the edge: same machine,
 * same load path, no internet between generator and server. Hitting the DEPLOYED
 * Worker over the public net would measure the network + CF's multi-tenant edge, not
 * the runtime — and would break the suite's "same machine, never cross-machine"
 * charter. (The deploy is validated separately: it builds, deploys, and serves
 * byte-identical bytes — see README → "Edge tier".)
 *
 * `wrangler dev` binds via a `--port` FLAG, not the PORT env the driver sets, so this
 * thin wrapper bridges the two and runs workerd locally (`--local`). Like the whole
 * driver it's CI/local — it cannot run in a sandbox that blocks server starts.
 */
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const port = process.env.PORT ?? "8787";
const here = dirname(fileURLToPath(import.meta.url));

// `--local` runs workerd locally (no account/network); `--inspector-port 0` takes a
// free debugger port so several edge apps don't collide on the default one;
// `--show-interactive-dev-session false` suppresses the hotkey UI so it never blocks
// on stdin under the driver / in CI (where it would hang waitForReady forever).
const child = spawn(
  "npx",
  [
    "--yes",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--show-interactive-dev-session",
    "false",
  ],
  { cwd: here, stdio: "inherit" },
);

child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
