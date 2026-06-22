import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { CLI_COMMANDS } from "../src/agents/commands";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

/**
 * Extract every command token the bin actually dispatches on — the `X` in each
 * `command === "X"` across `bin.ts` and `run.ts`. The empty-string sentinel
 * (`command === ""`, the no-arg help case) is not a command and is dropped.
 */
function dispatchedTokens(): Set<string> {
  const source = `${readFileSync(join(srcDir, "bin.ts"), "utf8")}\n${readFileSync(join(srcDir, "run.ts"), "utf8")}`;

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
});
