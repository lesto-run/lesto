import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { CLI_COMMANDS } from "../src/agents/commands";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

/** Strip block and line comments so a `command === "X"` inside a comment is not counted. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments (the `[^:]` guard spares `://` in URLs)
}

/**
 * Extract every command token the bin dispatches on — the `X` in each
 * `command === "X"` across `bin.ts` and `run.ts`, comments stripped first. The
 * empty-string sentinel (`command === ""`, the no-arg help case) is dropped.
 *
 * SCOPE (honest): this recognizes the LITERAL `command === "X"` idiom, which is the
 * whole of top-level dispatch today. A future command routed by some other form (a
 * `switch`, `startsWith`, a lookup table) would be invisible here — so a new
 * command MUST keep the literal idiom (or this guard must be taught the new form),
 * else the catalogue could silently drift. Subcommand dispatch (e.g. `generate
 * <sub>`) is deliberately out of scope: the catalogue lists top-level commands.
 */
function dispatchedTokens(): Set<string> {
  const source = stripComments(
    `${readFileSync(join(srcDir, "bin.ts"), "utf8")}\n${readFileSync(join(srcDir, "run.ts"), "utf8")}`,
  );

  const tokens = new Set<string>();
  const pattern = /command === "([^"]*)"/g;

  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    // The captured token (always present for this pattern); the empty-string
    // sentinel (`command === ""`) is falsy and so is excluded.
    const token = match[1];

    if (token) tokens.add(token);
  }

  return tokens;
}

/** Every token the catalogue claims dispatch for — primary names plus aliases. */
function declaredTokens(): Set<string> {
  return new Set(CLI_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
}

describe("CLI_COMMANDS catalogue integrity", () => {
  test("every command has a non-empty name and summary", () => {
    for (const command of CLI_COMMANDS) {
      expect(command.name.length).toBeGreaterThan(0);
      expect(command.summary.length).toBeGreaterThan(0);
    }
  });

  test("primary names are unique", () => {
    const names = CLI_COMMANDS.map((c) => c.name);

    expect(new Set(names).size).toBe(names.length);
  });

  test("no token is both a primary name and an alias", () => {
    const names = new Set(CLI_COMMANDS.map((c) => c.name));
    const aliases = CLI_COMMANDS.flatMap((c) => c.aliases ?? []);

    for (const alias of aliases) {
      expect(names.has(alias)).toBe(false);
    }
  });
});

describe("two-way sync with the bin's dispatch set", () => {
  test("every dispatched command token is declared in the catalogue", () => {
    const declared = declaredTokens();

    for (const token of dispatchedTokens()) {
      expect(declared, `dispatched "${token}" is missing from CLI_COMMANDS`).toContain(token);
    }
  });

  test("every declared command token is actually dispatched by the bin", () => {
    const dispatched = dispatchedTokens();

    for (const token of declaredTokens()) {
      expect(
        dispatched,
        `CLI_COMMANDS lists "${token}" but the bin dispatches no such command`,
      ).toContain(token);
    }
  });

  test("includes mcp and openapi (the commands USAGE omits)", () => {
    const declared = declaredTokens();

    expect(declared).toContain("mcp");
    expect(declared).toContain("openapi");
  });

  test("the comment strip prevents a commented-out dispatch from counting", () => {
    // A `command === "X"` inside a comment must not be read as a real dispatch.
    expect(stripComments('// command === "ghost"\nif (command === "real") {}')).not.toContain(
      "ghost",
    );
  });
});

describe("scan/catalogue purity (grep-asserted)", () => {
  // The Inc 1 acceptance requires the scan to be pure — no fs/process/node builtins.
  // Locked by a source read so a later stray `import "node:fs"` fails a test, not
  // just inspection.
  test.each(["types.ts", "commands.ts", "scan.ts", "managed-region.ts", "render-agents.ts"])(
    "%s imports no fs/process/node builtins",
    (file) => {
      const src = readFileSync(join(srcDir, "agents", file), "utf8");

      expect(src).not.toMatch(/from\s+["']node:/);
      expect(src).not.toMatch(/\brequire\s*\(/);
      expect(src).not.toMatch(/\bprocess\./);
      expect(src).not.toMatch(/from\s+["'](fs|path|os|child_process)["']/);
    },
  );
});
