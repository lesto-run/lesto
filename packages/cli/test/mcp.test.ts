import { beforeEach, describe, expect, it, vi } from "vitest";

import { keel } from "@keel/web";
import type { App, KeelAppConfig, KernelDatabase } from "@keel/kernel";
import type { KeelMcpContext, McpAuditRecord } from "@keel/mcp";

import { runMcp } from "../src/mcp";
import type { McpDeps } from "../src/mcp";

// A booted app stub: `runMcp` only drives its `handle` through the MCP context it
// builds, so a thin fake is enough for the command core.
const bootedApp: App = {
  migrationsApplied: [],
  handle: () => Promise.resolve({ status: 200, headers: {}, body: "" }),
};

// A code-first app whose routes the context surfaces. A sentinel db proves the
// content store is wired from `config.db`.
const sentinelDb = { sentinel: "db" } as unknown as KernelDatabase;

function buildConfig(): KeelAppConfig {
  const app = keel()
    .get("/posts", (c) => c.json({ posts: [] }))
    .post("/posts", (c) => c.json({ created: true }, 201));

  return { db: sentinelDb, app };
}

// Capture what `startMcpServer` was handed, plus the audit and banner streams.
let captured: KeelMcpContext | undefined;
let audit: string[];
let log: string[];

function depsWith(overrides: Partial<McpDeps> = {}): McpDeps {
  return {
    loadApp: () => Promise.resolve(buildConfig()),
    createApp: () => Promise.resolve(bootedApp),
    startMcpServer: (context) => {
      captured = context;

      return Promise.resolve();
    },
    audit: (line) => audit.push(line),
    log: (line) => log.push(line),
    ...overrides,
  };
}

beforeEach(() => {
  captured = undefined;
  audit = [];
  log = [];
});

describe("runMcp", () => {
  it("defaults to read-only mode and serves over stdio", async () => {
    const code = await runMcp([], depsWith());

    expect(code).toBe(0);
    expect(captured?.mode).toBe("read-only");
    expect(log).toEqual(["keel mcp: serving over stdio in read-only mode"]);
  });

  it("escalates to operator mode with --operator", async () => {
    await runMcp(["--operator"], depsWith());

    expect(captured?.mode).toBe("operator");
    expect(log).toEqual(["keel mcp: serving over stdio in operator mode"]);
  });

  it("surfaces the app's routes and wires the content store from config.db", async () => {
    await runMcp([], depsWith());

    expect(captured?.routes).toEqual([
      { method: "GET", pattern: "/posts" },
      { method: "POST", pattern: "/posts" },
    ]);
    expect(captured?.contentDb).toBe(sentinelDb);
    expect(captured?.app).toBe(bootedApp);
  });

  it("writes every dispatch to the audit sink as a structured line", async () => {
    await runMcp([], depsWith());

    const record: McpAuditRecord = {
      tool: "list_routes",
      inputHash: "abc123",
      outcome: "ok",
      durationMs: 7,
    };

    // The context's audit hook renders the record and forwards it to the sink.
    captured?.audit(record);

    expect(audit).toEqual(["mcp.audit tool=list_routes outcome=ok hash=abc123 duration_ms=7"]);
  });

  it("boots the app before standing up the server", async () => {
    const order: string[] = [];

    const createApp = vi.fn(() => {
      order.push("createApp");

      return Promise.resolve(bootedApp);
    });

    const startMcpServer = vi.fn((context: KeelMcpContext) => {
      order.push("startMcpServer");
      captured = context;

      return Promise.resolve();
    });

    await runMcp([], depsWith({ createApp, startMcpServer }));

    expect(order).toEqual(["createApp", "startMcpServer"]);
  });
});
