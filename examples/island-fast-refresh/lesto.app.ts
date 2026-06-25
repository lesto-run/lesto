/**
 * The island Fast Refresh DX gate (DX-parity R2, ADR 0011). A minimal Lesto app whose
 * only job is to prove the dev loop: with `@lesto/island-dev` installed, `lesto dev`
 * stands up a Vite dev server with Preact Fast Refresh, so editing
 * `app/islands/counter.tsx` re-renders the island in place — preserving its `useState`
 * — instead of full-reloading the page. The live proof is
 * `packages/e2e/island-fast-refresh.spec.ts`, which drives a real browser.
 *
 * Preact dialect (`ui.dialect: "preact"`) — the scaffold default, so this exercises the
 * exact path `npm create lesto-app` produces: the island client's `react` is aliased to
 * `preact/compat` (~10 KB), and `preact-render-to-string` renders the server half.
 *
 * It is db-backed only because `LestoAppConfig` requires a handle; the page reads no
 * data, so an in-memory SQLite with no migrations (and `durable: false`) is enough.
 */

import { createDb } from "@lesto/db";
import { openSqlite } from "@lesto/runtime";
import { lesto } from "@lesto/web";

import type { LestoAppConfig } from "@lesto/kernel";

const { db: handle } = await openSqlite(":memory:");
createDb(handle);

const config: LestoAppConfig = {
  db: handle,
  // `.client("/client.js")` emits the hydration entry tag; the file-routed home page
  // (app/routes/page.tsx) renders the Counter island into it.
  app: lesto().client("/client.js"),
  // No durable stores / migrations for this minimal dev-loop demo.
  durable: false,
  // The Preact dialect (scaffold default): the single key picks the island client's
  // `react` → `preact/compat` alias AND the matched Fast-Refresh plugin (`@prefresh/vite`).
  ui: { dialect: "preact" },
};

export default config;
