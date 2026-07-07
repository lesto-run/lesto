/**
 * The whole feature-flag journey, in-process, in one run.
 *
 *   bun run examples/flags/run.ts
 *
 * It boots the app and drives the actual HTTP routes through `app.handle`, so you
 * can watch each gated route exist or not depending on the flag — an off flag is a
 * 404, the feature simply absent — and watch a `resolve` lever flip it:
 *
 *   off by default    → 404      the feature does not exist to a client
 *   ?preview=1         → 200      a QA/preview escape hatch
 *   x-user-tier: beta  → 200      per-request TARGETING (dynamic beats static)
 *   on by default      → 200      a shipped feature, on for everyone
 *   x-kill-changelog:1 → 404      a request-time kill switch (dynamic beats static)
 *   undeclared flag    → 404      an unknown flag is off
 *   /beta subtree      → 404/200  one `.use(gate)` hides the whole area
 *
 * It ends by printing the /flags resolution table for a few different requests, so
 * the dynamic-then-static rule is legible side by side rather than inferred.
 */

import { buildApp } from "./src/app";

type App = ReturnType<typeof buildApp>["app"];
type Opts = { query?: Record<string, string>; headers?: Record<string, string> };

/** GET a path (with optional query/headers) and format its status for the log. */
async function show(app: App, label: string, path: string, opts?: Opts): Promise<void> {
  const res = await app.handle("GET", path, opts ?? {});
  const body = typeof res.body === "string" ? res.body : "";
  const preview = body.length > 60 ? `${body.slice(0, 57)}…` : body;

  console.log(`  ${label.padEnd(42)} → ${res.status} ${preview}`);
}

async function main(): Promise<void> {
  const { app } = buildApp();

  console.log("new-dashboard — OFF by default, flipped on by a resolve lever:");
  await show(app, "GET /dashboard", "/dashboard");
  await show(app, "GET /dashboard?preview=1", "/dashboard", { query: { preview: "1" } });
  await show(app, "GET /dashboard  (x-user-tier: beta)", "/dashboard", {
    headers: { "x-user-tier": "beta" },
  });
  await show(app, "GET /dashboard  (x-user-tier: free)", "/dashboard", {
    headers: { "x-user-tier": "free" },
  });

  console.log("\npublic-changelog — ON by default, killed at request time:");
  await show(app, "GET /changelog", "/changelog");
  await show(app, "GET /changelog  (x-kill-changelog: 1)", "/changelog", {
    headers: { "x-kill-changelog": "1" },
  });

  console.log("\nunlaunched-experiment — UNDECLARED, so always off:");
  await show(app, "GET /experiment", "/experiment");
  await show(app, "GET /experiment?preview=1", "/experiment", { query: { preview: "1" } });

  console.log("\nbeta — a whole SUBTREE gated by one .use(gate):");
  await show(app, "GET /beta/labs", "/beta/labs");
  await show(app, "GET /beta/labs/settings", "/beta/labs/settings");
  await show(app, "GET /beta/labs?preview=1", "/beta/labs", { query: { preview: "1" } });

  console.log("\nresolution table (GET /flags) — dynamic-then-static, unknown ⇒ off:");
  const table = async (label: string, opts?: Opts): Promise<void> => {
    const res = await app.handle("GET", "/flags", opts ?? {});
    console.log(`  ${label.padEnd(28)} ${res.body}`);
  };
  await table("(no lever)");
  await table("?preview=1", { query: { preview: "1" } });
  await table("x-user-tier: beta", { headers: { "x-user-tier": "beta" } });
  await table("x-kill-changelog: 1", { headers: { "x-kill-changelog": "1" } });
}

await main();
