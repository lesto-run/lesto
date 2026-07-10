import { beforeEach, describe, expect, it, vi } from "vitest";

import { lesto } from "@lesto/web";
import type { App, LestoAppConfig, KernelDatabase } from "@lesto/kernel";
import { buildTools } from "@lesto/mcp";
import type { LestoMcpContext, McpAuditRecord } from "@lesto/mcp";

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

function buildConfig(): LestoAppConfig {
  const app = lesto()
    .get("/posts", (c) => c.json({ posts: [] }))
    .post("/posts", (c) => c.json({ created: true }, 201));

  return { db: sentinelDb, app };
}

// Capture what `startMcpServer` was handed, plus the audit and banner streams.
let captured: LestoMcpContext | undefined;
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
    expect(log).toEqual(["lesto mcp: serving over stdio in read-only mode"]);
  });

  it("escalates to operator mode with --operator", async () => {
    await runMcp(["--operator"], depsWith());

    expect(captured?.mode).toBe("operator");
    expect(log).toEqual(["lesto mcp: serving over stdio in operator mode"]);
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
      // Unattributed: the CLI stdio server wires no principal resolver yet (OCP-6
      // resolves+records the actor; the resolver wiring lands with OCP-7).
      actor: undefined,
    };

    // The context's audit hook renders the record and forwards it to the sink.
    captured?.audit(record);

    expect(audit).toEqual(["mcp.audit tool=list_routes outcome=ok hash=abc123 duration_ms=7"]);
  });

  it("carries the read-only app contract: openApiInfo + the declared schema shape", async () => {
    const app = lesto().get("/posts", (c) => c.json({ posts: [] }));
    const config: LestoAppConfig = {
      db: sentinelDb,
      app,
      migrations: [
        { version: "001_create_posts", migration: { up: () => {} } },
        { version: "002_add_index", migration: { up: () => {} } },
      ],
    };

    await runMcp([], depsWith({ loadApp: () => Promise.resolve(config) }));

    // No app-meta source yet, so info is the shared default; the schema surfaces the
    // boot migration versions (tables are the deferred-introspection empty floor).
    expect(captured?.openApiInfo).toEqual({ title: "Lesto API", version: "0.0.0" });
    expect(captured?.schema).toEqual({
      migrations: ["001_create_posts", "002_add_index"],
      tables: [],
    });
  });

  it("derives an empty migration list when the app declares none", async () => {
    await runMcp([], depsWith());

    expect(captured?.schema).toEqual({ migrations: [], tables: [] });
  });

  it("advertises generate_ui and runs the injected generator when generateUi is wired", async () => {
    // The bin injects this only past its key + registry gate (see bin.ts); the core just
    // threads it onto the context so the tool's handler reaches it.
    const generateUi = vi.fn((prompt: string) =>
      Promise.resolve({ tree: prompt, valid: true, errors: [] }),
    );

    await runMcp([], depsWith({ generateUi }));

    // Wired: the context carries the generator and omits nothing, so the tool is advertised.
    expect(captured?.generateUi).toBe(generateUi);
    expect(captured?.omitTools).toBeUndefined();

    const tool = buildTools(captured!).find((entry) => entry.name === "generate_ui");

    expect(tool).toBeDefined();

    // Invoking the advertised tool runs the injected generator with the prompt — no longer the
    // inert MCP_GENERATE_UNAVAILABLE throw.
    const result = await tool!.handler({ prompt: "a sign-up form" });

    expect(generateUi).toHaveBeenCalledWith("a sign-up form");
    expect(result).toEqual({ tree: "a sign-up form", valid: true, errors: [] });
  });

  it("omits generate_ui from the surface when no generator is injected", async () => {
    await runMcp([], depsWith());

    // Unwired: no generator on the context, and generate_ui is named in omitTools so the
    // surface is honest — the tool is absent, not present-and-inert.
    expect(captured?.generateUi).toBeUndefined();
    expect(captured?.omitTools).toEqual(["generate_ui"]);

    const toolNames = buildTools(captured!).map((entry) => entry.name);

    expect(toolNames).not.toContain("generate_ui");
  });

  it("boots the app before standing up the server", async () => {
    const order: string[] = [];

    const createApp = vi.fn(() => {
      order.push("createApp");

      return Promise.resolve(bootedApp);
    });

    const startMcpServer = vi.fn((context: LestoMcpContext) => {
      order.push("startMcpServer");
      captured = context;

      return Promise.resolve();
    });

    await runMcp([], depsWith({ createApp, startMcpServer }));

    expect(order).toEqual(["createApp", "startMcpServer"]);
  });
});
