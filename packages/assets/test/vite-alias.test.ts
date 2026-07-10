/**
 * The shared Vite dialect config — the preact alias map and the per-dialect runtime
 * deps both bundlers (prod `vite-build.ts`, dev `@lesto/island-dev`) consume. The
 * load-bearing properties are asserted directly: the anchored `react` → `preact/compat`
 * alias (so `react` is rewritten without also catching `react-dom`), and each dialect's
 * exact `dedupe` + `include` lists (the duplicate-runtime guard + the pre-bundle set),
 * which MUST match the dev config byte-for-byte so dev and prod never drift.
 */

import { describe, expect, it } from "vitest";

import { PREACT_ALIAS } from "../src/preact-alias";
import { dialectRuntimeDeps, preactAliases } from "../src/vite-alias";

describe("preactAliases", () => {
  it("anchors `react` so it is rewritten without catching `react-dom`", () => {
    const reactAlias = preactAliases().find((a) => a.replacement === "preact/compat");

    expect(reactAlias).toBeDefined();
    expect(reactAlias?.find.test("react")).toBe(true);
    // The anchored `^react$` must NOT match the longer `react-dom`, which has no entry.
    expect(reactAlias?.find.test("react-dom")).toBe(false);
  });

  it("aliases the slash-bearing specifiers (escaped + anchored)", () => {
    const aliases = preactAliases();

    const client = aliases.find((a) => a.find.test("react-dom/client"));

    expect(client?.replacement).toBe("preact/compat/client");
    // Anchored: a trailing-suffixed near-match is rejected.
    expect(client?.find.test("react-dom/clientX")).toBe(false);

    const jsx = aliases.find((a) => a.find.test("react/jsx-runtime"));

    expect(jsx?.replacement).toBe("preact/jsx-runtime");
    expect(jsx?.find.test("react/jsx-runtimeX")).toBe(false);

    const jsxDev = aliases.find((a) => a.find.test("react/jsx-dev-runtime"));

    expect(jsxDev?.replacement).toBe("preact/jsx-runtime");
    expect(jsxDev?.find.test("react/jsx-dev-runtimeX")).toBe(false);
  });

  it("escapes the `/` in a specifier so it matches literally, not as a regex char", () => {
    // A bare-`react` alias must not match `reactXjs-runtime` (no literal `/`); the
    // escaped, anchored `react/jsx-runtime` is its own distinct entry.
    const jsx = preactAliases().find((a) => a.find.test("react/jsx-runtime"));

    expect(jsx?.find.test("reactXjsx-runtime")).toBe(false);
  });

  it("derives exactly one alias per PREACT_ALIAS entry", () => {
    // Four entries today (`react`, `react-dom/client`, `react/jsx-runtime`,
    // `react/jsx-dev-runtime`) — one anchored regex each, none extra.
    expect(preactAliases()).toHaveLength(4);
  });
});

describe("dialectRuntimeDeps", () => {
  it("dedupes both react runtimes and pre-bundles the dev jsx runtime for react", () => {
    expect(dialectRuntimeDeps("react")).toEqual({
      dedupe: ["react", "react-dom"],
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        // `react/jsx-dev-runtime` (NOT just `jsx-runtime`) is the dev automatic runtime.
        "react/jsx-dev-runtime",
      ],
    });
  });

  it("dedupes preact and pre-bundles its compat layer (incl. the client renderer) for preact", () => {
    expect(dialectRuntimeDeps("preact")).toEqual({
      dedupe: ["preact"],
      include: [
        "preact",
        "preact/hooks",
        "preact/compat",
        // `preact/compat/client` is the `react-dom/client` alias target the dev entry
        // imports; without it the first island request re-optimizes and 504s (L-4027e1f0).
        "preact/compat/client",
        "preact/jsx-runtime",
      ],
    });
  });

  // The PROPERTY the literal list above only incidentally encodes — and the one that
  // actually broke (L-4027e1f0): an alias rewrites a specifier BEFORE optimization, so a
  // target Vite never pre-bundles gets discovered mid-crawl → re-optimize → 504. This
  // fails the moment someone adds a PREACT_ALIAS entry without pre-bundling its target,
  // which a `toEqual` on the current list can never catch.
  it("pre-bundles every react→preact alias target", () => {
    const { include } = dialectRuntimeDeps("preact");

    for (const target of Object.values(PREACT_ALIAS)) {
      expect(include).toContain(target);
    }
  });
});
