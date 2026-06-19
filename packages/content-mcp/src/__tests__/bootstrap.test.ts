import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempDir, type TempDirContext } from "./test-utils";

/**
 * Coverage for the stdio bootstrap entry points (startMcpServer /
 * startMcpHttpServer). These wire a server to a stdio transport and register
 * SIGINT/SIGTERM handlers that close the server and exit. We swap the stdio
 * transport for a no-op transport so the handlers run without touching real
 * stdio or killing the test runner, then drive the signal handlers and assert
 * the server closes and the process exits cleanly.
 */

// A transport that satisfies the SDK's Transport contract without any I/O.
class FakeTransport {
  onclose?: () => void;
  onerror?: (err: Error) => void;
  onmessage?: (msg: unknown) => void;
  async start(): Promise<void> {}
  async send(): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }
}

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: FakeTransport,
}));

const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Spy on `process.exit` and expose a promise that resolves once it has been
 * called twice (one per signal). The signal handlers are async — they close the
 * server before exiting — so the test must await the REAL completion rather than
 * a fixed sleep. A prior `setTimeout(r, 1)` flaked under parallel-coverage CPU
 * oversubscription, where 1ms was not enough for the async close→exit chain to
 * run; this waits for the actual second exit, deterministic under any load.
 */
function spyOnDoubleExit(): { spy: MockInstance; calledTwice: Promise<void> } {
  // Assigned synchronously by the Promise executor below (definite assignment).
  let markCalledTwice!: () => void;

  const calledTwice = new Promise<void>((resolve) => {
    markCalledTwice = resolve;
  });

  let count = 0;

  const spy = vi.spyOn(process, "exit").mockImplementation((() => {
    count += 1;

    if (count === 2) markCalledTwice();

    return undefined;
  }) as never);

  return { spy, calledTwice };
}

describe("stdio bootstrap entry points", () => {
  let ctx: TempDirContext;

  beforeEach(async () => {
    ctx = await createTempDir("mcp-bootstrap-", PACKAGE_DIR);
    await mkdir(join(ctx.tempDir, "content", "posts"), { recursive: true });
    await writeFile(
      join(ctx.tempDir, "docks.config.ts"),
      `import { z } from "zod";\nexport default { collections: [{ name: "posts", directory: "content/posts", schema: z.object({ title: z.string() }) }], mode: "development" };\n`,
    );
  });

  afterEach(async () => {
    await ctx.cleanup();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    vi.restoreAllMocks();
  });

  it("startMcpServer connects a transport and wires signal handlers that close + exit", async () => {
    const { spy: exitSpy, calledTwice } = spyOnDoubleExit();
    const { startMcpServer } = await import("../server");

    await startMcpServer({ cwd: ctx.tempDir });
    expect(process.listenerCount("SIGINT")).toBe(1);
    expect(process.listenerCount("SIGTERM")).toBe(1);

    process.emit("SIGINT");
    process.emit("SIGTERM");
    await calledTwice;

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).toHaveBeenCalledTimes(2);
  });

  it("startMcpHttpServer connects a transport and wires signal handlers that close + exit", async () => {
    const { spy: exitSpy, calledTwice } = spyOnDoubleExit();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // No fetch stub -> Studio health check fails -> server still constructs.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const { startMcpHttpServer } = await import("../http");

    await startMcpHttpServer({ studioUrl: "http://localhost:4400" });
    expect(process.listenerCount("SIGINT")).toBe(1);
    expect(process.listenerCount("SIGTERM")).toBe(1);
    expect(errSpy).toHaveBeenCalled();

    process.emit("SIGINT");
    process.emit("SIGTERM");
    await calledTwice;

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).toHaveBeenCalledTimes(2);
  });
});
