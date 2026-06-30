import { beforeEach, describe, expect, it } from "vitest";

import { CliError } from "../src/errors";
import { runAdd } from "../src/add";
import type { AddDeps } from "../src/add";

// The three files the `mcp-auth` integration scaffolds, in plan order.
const MCP_AUTH_FILES = ["app/mcp/config.ts", "app/mcp/verify.ts", "app/mcp/governance.ts"];

// Capture writes, the existing files (path → contents), and printed lines.
let written: { path: string; contents: string }[];
let existing: Map<string, string>;
let lines: string[];

function depsWith(overrides: Partial<AddDeps> = {}): AddDeps {
  return {
    exists: (path) => Promise.resolve(existing.has(path)),
    read: (path) => Promise.resolve(existing.get(path) ?? ""),
    write: (path, contents) => {
      written.push({ path, contents });

      return Promise.resolve();
    },
    out: (line) => lines.push(line),
    ...overrides,
  };
}

/** Run `add` and return the error it threw, or throw if it unexpectedly succeeded. */
async function refusal(args: readonly string[]): Promise<CliError> {
  try {
    await runAdd(args, depsWith());
  } catch (error) {
    return error as CliError;
  }

  throw new Error("expected a refusal but add succeeded");
}

/** The contents written to a given path, or undefined if it was not written. */
function contentsAt(path: string): string | undefined {
  return written.find((file) => file.path === path)?.contents;
}

beforeEach(() => {
  written = [];
  existing = new Map();
  lines = [];
});

describe("runAdd refusals", () => {
  it("refuses a missing integration with a coded error", async () => {
    const error = await refusal([]);

    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe("CLI_ADD_MISSING_INTEGRATION");
    expect(error.message).toContain("lesto add");
    expect(written).toEqual([]);
  });

  it("refuses an unknown integration with a coded error and the available list", async () => {
    const error = await refusal(["telemetry"]);

    expect(error.code).toBe("CLI_ADD_UNKNOWN_INTEGRATION");
    expect(error.message).toContain("telemetry");
    expect(error.message).toContain("mcp-auth");
    expect(error.details).toMatchObject({ integration: "telemetry", known: ["mcp-auth"] });
    expect(written).toEqual([]);
  });
});

describe("add mcp-auth", () => {
  it("scaffolds the config, verifier, and governance files in plan order", async () => {
    const code = await runAdd(["mcp-auth"], depsWith());

    expect(code).toBe(0);
    expect(written.map((file) => file.path)).toEqual(MCP_AUTH_FILES);
    expect(lines.filter((line) => line.startsWith("wrote "))).toEqual(
      MCP_AUTH_FILES.map((path) => `wrote ${path}`),
    );
  });

  it("emits a config.ts of TODO holes (issuer, jwksUrl, resource, baseUrl, scopes, origins)", async () => {
    await runAdd(["mcp-auth"], depsWith());

    const config = contentsAt("app/mcp/config.ts") ?? "";

    expect(config).toContain("export const SCOPES");
    expect(config).toContain("mcp:read");
    expect(config).toContain("mcp:write");
    expect(config).toContain("export const mcpAuthConfig");
    expect(config).toContain("issuer:");
    expect(config).toContain("jwksUrl: new URL(");
    expect(config).toContain("resource:");
    expect(config).toContain("baseUrl:");
    expect(config).toContain("allowedOrigins: []");
    // Every value is a deliberate TODO hole, not a guessed default.
    expect(config).toContain("TODO:");
  });

  it("emits a verify.ts that validates via jose against the configured issuer", async () => {
    await runAdd(["mcp-auth"], depsWith());

    const verify = contentsAt("app/mcp/verify.ts") ?? "";

    expect(verify).toContain('import { createRemoteJWKSet, jwtVerify } from "jose"');
    expect(verify).toContain(
      'import type { AccessTokenClaims, VerifyAccessToken } from "@lesto/mcp"',
    );
    expect(verify).toContain("export const verifyAccessToken: VerifyAccessToken");
    expect(verify).toContain("createRemoteJWKSet(mcpAuthConfig.jwksUrl)");
    expect(verify).toContain("issuer: mcpAuthConfig.issuer");
    // A bad token is a 401 (undefined), never a throw.
    expect(verify).toContain("return undefined");
    expect(verify).toContain("catch");
  });

  it("emits a governance.ts wiring createBearerAuthenticator → createMcpHttpHandlers + a rolesOf stub", async () => {
    await runAdd(["mcp-auth"], depsWith());

    const governance = contentsAt("app/mcp/governance.ts") ?? "";

    expect(governance).toContain(
      'import { createBearerAuthenticator, createMcpHttpHandlers } from "@lesto/mcp"',
    );
    expect(governance).toContain("export function rolesOf(subject: string)");
    expect(governance).toContain("createBearerAuthenticator({");
    expect(governance).toContain("verifyAccessToken,");
    expect(governance).toContain("resource: mcpAuthConfig.resource");
    expect(governance).toContain("createMcpHttpHandlers({");
    expect(governance).toContain("writeScope: SCOPES.write");
    expect(governance).toContain("allowedOrigins: mcpAuthConfig.allowedOrigins");
    // The RFC 9728 PRM, the MCP endpoint, and the GET-405 SSE-probe answer.
    expect(governance).toContain("/.well-known/oauth-protected-resource");
    expect(governance).toContain('.post("/mcp", handlers.rpc)');
    expect(governance).toContain("status: 405");
  });

  it("prints next steps after a real run, including the one-line mount", async () => {
    await runAdd(["mcp-auth"], depsWith());

    const joined = lines.join("\n");

    expect(joined).toContain("Next steps:");
    expect(joined).toContain("config.ts");
    expect(joined).toContain("verify.ts");
    expect(joined).toContain("rolesOf");
    expect(joined).toContain("buildGovernedMcp");
    expect(joined).toContain("app.route(buildGovernedMcp(app).api)");
    expect(joined).toContain("examples/mcp-auth-openauth");
  });
});

describe("add mcp-auth jose dependency", () => {
  it("adds jose to an existing package.json that lacks it", async () => {
    existing.set("package.json", JSON.stringify({ name: "my-app", dependencies: { zod: "^4.0.0" } }));

    await runAdd(["mcp-auth"], depsWith());

    const pkg = JSON.parse(contentsAt("package.json") ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.jose).toBeDefined();
    expect(pkg.dependencies.zod).toBe("^4.0.0"); // existing deps preserved
    expect(lines.join("\n")).toContain("added jose to package.json");
  });

  it("adds jose to a package.json that has no dependencies block at all", async () => {
    existing.set("package.json", JSON.stringify({ name: "my-app" }));

    await runAdd(["mcp-auth"], depsWith());

    const pkg = JSON.parse(contentsAt("package.json") ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.jose).toBeDefined();
  });

  it("leaves package.json untouched when jose is already present", async () => {
    existing.set("package.json", JSON.stringify({ dependencies: { jose: "^6.0.0" } }));

    await runAdd(["mcp-auth"], depsWith());

    expect(contentsAt("package.json")).toBeUndefined(); // never written
    expect(lines.join("\n")).toContain("jose: already in package.json");
  });

  it("notes the missing package.json rather than failing", async () => {
    await runAdd(["mcp-auth"], depsWith()); // no package.json in `existing`

    expect(contentsAt("package.json")).toBeUndefined();
    expect(lines.join("\n")).toContain("no package.json here");
  });

  it("on --dry-run, says it would add jose and writes nothing", async () => {
    existing.set("package.json", JSON.stringify({ dependencies: {} }));

    await runAdd(["mcp-auth", "--dry-run"], depsWith());

    expect(contentsAt("package.json")).toBeUndefined();
    expect(lines.join("\n")).toContain("would add jose to package.json");
  });
});

describe("add mcp-auth idempotency", () => {
  it("skips a byte-identical existing file without rewriting it", async () => {
    // Pre-seed config.ts with EXACTLY what the generator would emit.
    const first = depsWith();
    await runAdd(["mcp-auth"], first);
    const configContents = contentsAt("app/mcp/config.ts")!;

    written = [];
    lines = [];
    existing.set("app/mcp/config.ts", configContents);

    await runAdd(["mcp-auth"], depsWith());

    expect(lines).toContain("exists app/mcp/config.ts (unchanged)");
    // The other two files are still fresh, so they are written.
    expect(written.map((file) => file.path)).toEqual([
      "app/mcp/verify.ts",
      "app/mcp/governance.ts",
    ]);
  });

  it("leaves an existing-but-different file untouched and says so", async () => {
    existing.set("app/mcp/verify.ts", "// my hand-edited verifier\n");

    await runAdd(["mcp-auth"], depsWith());

    expect(lines).toContain(
      "exists app/mcp/verify.ts (differs — left unchanged; edit or delete to regenerate)",
    );
    // The differing file is never clobbered.
    expect(contentsAt("app/mcp/verify.ts")).toBeUndefined();
  });
});

describe("add mcp-auth --dry-run", () => {
  it("prints the plan and writes nothing", async () => {
    const code = await runAdd(["mcp-auth", "--dry-run"], depsWith());

    expect(code).toBe(0);
    expect(written).toEqual([]);
    // The file-plan lines (the jose note follows; no package.json in this fixture).
    expect(lines.slice(0, 3)).toEqual(MCP_AUTH_FILES.map((path) => `would write ${path}`));
    // A dry run wrote nothing, so it prints no next-steps.
    expect(lines.join("\n")).not.toContain("Next steps:");
  });

  it("reports a would-skip for a path that already exists", async () => {
    existing.set("app/mcp/governance.ts", "// already here\n");

    await runAdd(["mcp-auth", "--dry-run"], depsWith());

    expect(lines.slice(0, 3)).toEqual([
      "would write app/mcp/config.ts",
      "would write app/mcp/verify.ts",
      "would skip app/mcp/governance.ts",
    ]);
    expect(written).toEqual([]);
  });
});
