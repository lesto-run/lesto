import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildTools, mcpModeForScopes } from "../src";
import type { LestoMcpContext } from "../src";

// These guard the *structural* acceptance criteria of the remote-MCP transport (OCP-9):
// the no-`kernel → mcp` edge and the confused-deputy defaults. The transport wiring
// itself is coverage-excluded; what must hold true about it is asserted here.

const here = fileURLToPath(new URL(".", import.meta.url));
const kernelDir = join(here, "..", "..", "kernel");

/** Every `.ts` file under a directory, recursively. */
function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return tsFilesUnder(path);

    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

describe("no kernel → mcp edge (the app mounts the transport, never the kernel)", () => {
  it("@lesto/kernel does not depend on @lesto/mcp", () => {
    const pkg = JSON.parse(readFileSync(join(kernelDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    const everyDep = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };

    expect(everyDep["@lesto/mcp"]).toBeUndefined();
  });

  it("no @lesto/kernel source imports @lesto/mcp", () => {
    const offenders = tsFilesUnder(join(kernelDir, "src")).filter((file) =>
      readFileSync(file, "utf8").includes("@lesto/mcp"),
    );

    expect(offenders).toEqual([]);
  });
});

describe("confused-deputy defaults on the MCP surface", () => {
  const context = {
    app: { handle: () => Promise.resolve({ status: 200, headers: {}, body: "" }) },
    routes: [],
    audit: () => {},
  } as unknown as LestoMcpContext;

  it("never exposes an impersonation tool", () => {
    const names = buildTools(context).map((tool) => tool.name);

    expect(names.some((name) => /impersonat|sudo|become|act[_-]?as/i.test(name))).toBe(false);
  });

  it("floors an unscoped (or read-only) token to read-only mode — no write without the write scope", () => {
    expect(mcpModeForScopes([], { writeScope: "mcp:write" })).toBe("read-only");
    expect(mcpModeForScopes(["mcp:read"], { writeScope: "mcp:write" })).toBe("read-only");
  });
});
