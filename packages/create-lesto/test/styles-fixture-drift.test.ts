import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stylesApp } from "../src/index";

// DRIFT GUARD (L-c808978e). `@lesto/styles`'s real-engine integration test
// (packages/styles/test/shadcn-scaffold.integration.test.ts) compiles a BYTE-FOR-BYTE
// snapshot of stylesApp()'s output — the fixture below — as its INPUT. That fixture lives
// in a different package, so editing stylesApp() here silently leaves the snapshot stale and
// the integration test then compiles OLD css, undetected, until someone regenerates it by
// hand. This test fails CI the moment stylesApp() drifts from the committed fixture, so the
// two stay in lockstep. If it fails legitimately (you meant to change the scaffold css),
// regenerate the fixture with the command in REGENERATE below and re-run.
const FIXTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "styles",
  "test",
  "fixtures",
  "shadcn-scaffold.app.css",
);

const REGENERATE =
  "stylesApp() drifted from packages/styles/test/fixtures/shadcn-scaffold.app.css. " +
  "If the change is intended, regenerate the fixture:\n" +
  `  bun -e 'import {stylesApp} from "./packages/create-lesto/src/templates.ts"; ` +
  `import {writeFileSync} from "node:fs"; ` +
  `writeFileSync("./packages/styles/test/fixtures/shadcn-scaffold.app.css", stylesApp())'`;

describe("stylesApp() ↔ @lesto/styles compile fixture", () => {
  it("matches the committed shadcn-scaffold.app.css byte-for-byte", () => {
    const fixture = readFileSync(FIXTURE, "utf8");
    expect(stylesApp(), REGENERATE).toBe(fixture);
  });
});
