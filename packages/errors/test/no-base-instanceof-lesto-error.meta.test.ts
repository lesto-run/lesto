/**
 * META-TEST for the custom oxlint `jsPlugins` rule
 * `lesto-errors/no-base-instanceof-lesto-error`
 * (`../lint/no-base-instanceof-lesto-error.ts`).
 *
 * `jsPlugins` is an evolving oxlint feature. If a future oxlint resolves a
 * version that parses `jsPlugins` differently — or drops it — the rule silently
 * stops loading: `ws:lint` stays GREEN and the `@lesto/errors` brand invariant
 * is no longer enforced, with NO error. A guard that no longer guards
 * manufactures false confidence. (This is also why the root `package.json` now
 * pins an EXACT `oxlint` version rather than a caret range.)
 *
 * This test runs the REAL root `.oxlintrc.json` — the same config `ws:lint`
 * discovers — over throwaway fixtures and asserts the rule actually FIRES. It
 * goes RED the instant the plugin fails to load, so a jsPlugins-breaking oxlint
 * bump can never land quietly.
 *
 * Non-vacuous by construction: the two positive cases assert the rule id + a
 * real finding + exit 1 on sources that genuinely contain the violation; the
 * negative control asserts the rule STAYS SILENT (exit 0, id absent) on a
 * subclass check — so the positive assertions provably distinguish a violation
 * from a clean file, not merely "some output happened".
 *
 * The fixtures live in a fresh OS temp dir (never under a `test/` path) so the
 * `.oxlintrc.json` `overrides` block — which disables this rule for test files —
 * does NOT apply and the rule is evaluated with full force.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const RULE_ID = "no-base-instanceof-lesto-error";

const here = dirname(fileURLToPath(import.meta.url));
// test/ -> errors/ -> packages/ -> repo root
const repoRoot = resolve(here, "..", "..", "..");
const rootConfig = join(repoRoot, ".oxlintrc.json");

// Resolve the exact oxlint that got installed (the pinned copy), via its own
// package.json `bin` field, and run it through the node that runs this test —
// no reliance on PATH, a shebang, or the executable bit.
const requireFromHere = createRequire(import.meta.url);
const oxlintPkgPath = requireFromHere.resolve("oxlint/package.json");
const oxlintPkg = JSON.parse(readFileSync(oxlintPkgPath, "utf8")) as {
  bin?: string | Record<string, string>;
};
const binField = oxlintPkg.bin;
const binRelative = typeof binField === "string" ? binField : binField?.oxlint;
if (!binRelative) {
  throw new Error(`could not resolve the oxlint bin from ${oxlintPkgPath}`);
}
const oxlintBin = resolve(dirname(oxlintPkgPath), binRelative);

interface LintOutcome {
  status: number | null;
  output: string;
}

function lintSource(source: string): LintOutcome {
  const dir = mkdtempSync(join(tmpdir(), "lesto-errors-brand-guard-"));
  const fixture = join(dir, "fixture.ts");
  writeFileSync(fixture, source);

  const result = spawnSync(process.execPath, [oxlintBin, "--config", rootConfig, fixture], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.error) throw result.error;

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("no-base-instanceof-lesto-error (meta: the jsPlugins rule loads & fires)", () => {
  it("FIRES on a bare base-class `instanceof LestoError`", () => {
    const { status, output } = lintSource(
      "declare const value: unknown;\nexport const isBase = value instanceof LestoError;\n",
    );

    // If a future oxlint disables jsPlugins, the plugin never loads, this
    // finding never appears, and THIS assertion goes RED — loudly.
    expect(output).toContain(RULE_ID);
    expect(output).toContain("instanceof LestoError");
    expect(status).toBe(1);
  });

  it("FIRES on a namespaced base-class `instanceof errors.LestoError`", () => {
    const { status, output } = lintSource(
      'import * as errors from "@lesto/errors";\n' +
        "declare const value: unknown;\n" +
        "export const isBase = value instanceof errors.LestoError;\n",
    );

    expect(output).toContain(RULE_ID);
    expect(status).toBe(1);
  });

  it("STAYS SILENT on a subclass `instanceof QueueError` (control)", () => {
    // Proves the positive cases above genuinely discriminate: the identical
    // harness produces NO finding and a clean exit when the violation is absent.
    const { status, output } = lintSource(
      "declare const value: unknown;\nexport const isSub = value instanceof QueueError;\n",
    );

    expect(output).not.toContain(RULE_ID);
    expect(status).toBe(0);
  });
});
