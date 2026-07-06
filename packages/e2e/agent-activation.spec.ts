import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, test } from "@playwright/test";

import { killAndWait, run, spawnDev, waitForServer } from "./dev-harness";
import { lestoBin, REPO_ROOT } from "./scaffold-real-helpers";

/**
 * The AGENT-ACTIVATION gate — the ATTACK-PLAN-2027 §0 "agent activation" metric, automated:
 * can an agent one-shot the published real-user loop, zero → scaffold → running dev → first
 * MCP operation?
 *
 * The loop this proves, end-to-end, off the REAL npm registry (no workspace link, no local
 * pack — see the scaffold-e2e masking lesson):
 *
 *   1. `bunx create-lesto@<published>` scaffolds an app;
 *   2. `bun install` (hoisted — the standalone-scaffold default, the real-user layout);
 *   3. `lesto dev` boots and answers a WHATWG `fetch()` client (undici — the default HTTP
 *      client of every Node/Bun agent harness, and the one that exposed the port-4190
 *      false-oracle trap, L-513dd8a6);
 *   4. the dev MCP control plane's stderr banner is parsed exactly as a real agent must
 *      parse it (URL + `x-lesto-dev-token`; the port is ephemeral, the token per-session);
 *   5. a REAL `@modelcontextprotocol/sdk` Streamable-HTTP client — the same stack Claude
 *      Code uses — completes initialize → `tools/list` → a `describe_app` round-trip;
 *   6. and the negative control: a wrong token is refused 403, so the green above is a
 *      GOVERNED pass, not an open door (and not a vacuous one).
 *
 * Nightly + dispatch via `.github/workflows/agent-activation.yml`, never a PR gate (it
 * resolves the published closure from the live registry — network weather). The browser
 * half of the published-scaffold story (hydration) lives in scaffold-real-install leg (a);
 * this spec is deliberately browser-free so the agent loop has its own, faster signal.
 */

// The in-tree create-lesto version pins the published scaffold, advancing with each republish
// (same idiom as scaffold-real-install leg (a)).
const CREATE_LESTO_VERSION = (
  JSON.parse(
    readFileSync(join(REPO_ROOT, "packages", "create-lesto", "package.json"), "utf8"),
  ) as { version: string }
).version;

// A fetchable fixed port (`spawnDev`'s `assertFetchablePort` enforces), unique across ALL the
// e2e specs — the full inventory, not just the scaffold family (a first draft picked 4194 and
// collided with bundler-parity): 4180 fixture webServer, 4187 opfs, 4188 scaffold-loop,
// 4189 island-hmr, 4190 BLOCKED (the L-513dd8a6 trap), 4191/4193 scaffold-real,
// 4192 hoisted-preflight, 4194/4195 bundler-parity, 4196/4197 island-concurrent,
// 4198/4199 page-swap. A `fullyParallel` bare `playwright test` runs every spec at once, so a
// duplicate port false-reds on the pre-spawn availability probe.
const PORT = 4200;

// The one banner line `lesto dev` prints for the control plane — parsed here exactly the way
// a real agent (or the scaffolded AGENTS.md recipe) parses it.
const BANNER = /MCP control plane on (http:\/\/127\.0\.0\.1:\d+\/) \(x-lesto-dev-token: ([0-9a-f]+)\)/;

test.describe(`agent activation — published ${CREATE_LESTO_VERSION}, hoisted, real registry @agent-activation`, () => {
  // One scaffold + one dev server shared across the tests below, in order.
  test.describe.configure({ mode: "serial" });

  let workspace: string;
  let dev: ChildProcess | undefined;
  let mcpUrl = "";
  let mcpToken = "";

  test.beforeAll(async () => {
    // Registry resolution + a full install are well past the default 30s hook budget.
    test.setTimeout(600_000);

    workspace = await mkdtemp(join(tmpdir(), "lesto-agent-activation-"));
    const appDir = join(workspace, "activation-app");

    // The exact commands a real user (or their agent) runs.
    await run(
      "bunx",
      [`create-lesto@${CREATE_LESTO_VERSION}`, "activation-app", "--yes", "--no-install", "--no-git"],
      workspace,
    );
    await run("bun", ["install", "--linker=hoisted"], appDir);

    const devProc = await spawnDev(lestoBin(appDir), appDir, PORT);
    dev = devProc.child;

    await waitForServer(`http://127.0.0.1:${PORT}/`, 60_000, devProc);

    // The app answering does not guarantee the MCP banner has flushed into our capture buffer
    // yet, so poll the captured output briefly instead of assuming interleaving.
    const deadline = Date.now() + 30_000;
    let match = BANNER.exec(devProc.output());

    while (match === null) {
      if (Date.now() > deadline || devProc.hasExited()) {
        throw new Error(
          `lesto dev printed no MCP control-plane banner within 30s.\n--- captured output ---\n${devProc.output()}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
      match = BANNER.exec(devProc.output());
    }

    const [, url, token] = match;

    if (url === undefined || token === undefined) {
      throw new Error(`MCP banner matched but captured no url/token: ${match[0]}`);
    }

    mcpUrl = url;
    mcpToken = token;
  });

  test.afterAll(async () => {
    await killAndWait(dev);
    await rm(workspace, { recursive: true, force: true });
  });

  test("the published dev answers a WHATWG fetch client (undici)", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/`);

    expect(response.status).toBe(200);
  });

  test("an MCP client one-shots the activation loop: initialize → tools/list → describe_app", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { "x-lesto-dev-token": mcpToken } },
    });
    const client = new Client(
      { name: "agent-activation-gate", version: "0.0.0" },
      { capabilities: {} },
    );

    // The SDK's transport types clash with `exactOptionalPropertyTypes` — the repo-standard
    // bridge (same as examples/mcp-auth-openauth/_verify-live.ts).
    await client.connect(transport as Transport);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toContain("describe_app");
      expect(names).toContain("list_routes");

      const result = await client.callTool({ name: "describe_app", arguments: {} });
      const [first] = result.content as Array<{ type: string; text: string }>;

      expect(first?.type).toBe("text");

      // One round-trip hands the agent the whole app: routes, contract, content, schema.
      const payload = JSON.parse(first?.text ?? "") as {
        routes: unknown[];
        openapi: unknown;
        collections: unknown;
        schema: unknown;
      };

      expect(Array.isArray(payload.routes)).toBe(true);
      expect(payload.routes.length).toBeGreaterThan(0);
      expect(payload.openapi).toBeDefined();
      expect(payload.schema).toBeDefined();
    } finally {
      await client.close();
    }
  });

  test("the token gate holds: a wrong token is refused with 403", async () => {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-lesto-dev-token": "0".repeat(64),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(403);
  });
});
