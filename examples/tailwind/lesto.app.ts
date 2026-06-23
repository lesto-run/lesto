/**
 * The CSS-pipeline dogfood (ADR 0037): a Lesto app whose only job is to prove the
 * Tailwind v4 build end to end. `lesto build` reads `ui.css` (`app/styles/app.css`),
 * compiles it through `@lesto/styles` to `out/styles.css`, and `.styles("/styles.css")`
 * links it into every prerendered page. The home page (`app/routes/page.tsx`) renders
 * with utility classes a real stylesheet must back — so a missing or broken CSS build
 * shows up as an unstyled page, not a green test.
 *
 * It is db-backed only because `LestoAppConfig` requires a handle; the page reads no
 * data, so an in-memory SQLite with no migrations is enough.
 */

import { createDb } from "@lesto/db";
import { lesto } from "@lesto/web";
import { openSqlite } from "@lesto/runtime";
import type { LestoAppConfig } from "@lesto/kernel";

const { db: handle } = await openSqlite(":memory:");
createDb(handle);

const app = lesto()
  // The Tailwind stylesheet built from `ui.css` below — auto-linked on every page.
  .styles("/styles.css");

const config: LestoAppConfig = {
  db: handle,
  app,
  // No durable stores / migrations for this minimal CSS demo.
  durable: false,
  // `dialect` picks the island runtime (this demo ships none, so React is fine);
  // `css` is the Tailwind v4 entry the CLI compiles to `out/styles.css` (ADR 0037).
  ui: { dialect: "react", css: "app/styles/app.css" },
};

export default config;
