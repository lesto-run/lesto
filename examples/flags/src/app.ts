/**
 * examples/flags — @lesto/flags feature-flag gating behind real HTTP routes.
 *
 * The whole point of a flag is that an OFF feature does not exist to a client:
 * `flags.gate(name)` is middleware that answers a plain 404 when its flag is off,
 * so a route in progress neither 403-advertises itself nor leaks its shape. This
 * app puts every flag behavior at the HTTP boundary so you can watch a route wink
 * in and out of existence as a flag flips:
 *
 *   GET /dashboard    gated on an OFF-by-default flag → 404, until a lever flips it:
 *                       ?preview=1                (a QA/preview escape hatch), or
 *                       x-user-tier: beta         (per-request TARGETING) → 200
 *   GET /changelog    gated on an ON-by-default flag → 200 for everyone, until a
 *                     request-time kill switch (x-kill-changelog: 1) flips it → 404
 *   GET /experiment   gated on an UNDECLARED flag → always 404 (an unknown flag is off)
 *   GET /beta/*       a whole SUBTREE hidden by one `.use(flags.gate("beta"))`
 *   GET /flags        a diagnostic: `flags.enabled(name, c)` for THIS request, so the
 *                     resolution outcome (dynamic vs static, unknown ⇒ off) is legible
 *
 * Resolution is dynamic-then-static: `resolve(flag, c)` is consulted first (returning
 * a boolean to decide, or `undefined` to defer), then the static `defaults` map, and
 * an undeclared flag is off. The `resolve` here shows dynamic beating static in BOTH
 * directions — turning an off flag on (`new-dashboard`) and a shipped flag off
 * (`public-changelog`) — which is the one thing a static-only config cannot express.
 *
 * Only `@lesto/flags`' public API is used for gating (`defineFlags`, the `Flags`
 * type, `flags.gate`, `flags.enabled`); the routes are plain `@lesto/web`. There is
 * no database — a flag decision is pure computation over the request.
 */

import { defineFlags } from "@lesto/flags";
import type { Flags } from "@lesto/flags";
import { lesto } from "@lesto/web";
import type { Lesto } from "@lesto/web";

/**
 * Declare the app's flags and how each resolves per request.
 *
 * `defaults` is the static on/off baseline — the answer when `resolve` defers. The
 * dynamic `resolve` runs FIRST and wins when it returns a boolean; it returns
 * `undefined` to fall through to the default. An undeclared flag (no default, never
 * resolved) is off — the safe default, so a route gated on a name nobody wrote down
 * simply 404s.
 */
export function buildFlags(): Flags {
  return defineFlags({
    defaults: {
      "new-dashboard": false, // still rolling out → hidden by default
      "public-changelog": true, // shipped → on for everyone by default
      beta: false, // the beta subtree → hidden by default
      // "unlaunched-experiment" is deliberately UNDECLARED: an undeclared flag is
      // off, so the route gated on it 404s with nothing to write down here.
    },

    resolve: (flag, c) => {
      // A QA/preview lever: ?preview=1 opts THIS one request into the features
      // still rolling out — see the gated route without editing the defaults.
      if ((flag === "new-dashboard" || flag === "beta") && c.query("preview") === "1") {
        return true;
      }

      // Per-request TARGETING: a beta-tier principal gets the new dashboard and
      // nobody else does. The rollout keys off a per-request signal — here an
      // `x-user-tier` header standing in for the authenticated principal's tier
      // (a real app reads it off the resolved session/principal, not a raw header).
      if (flag === "new-dashboard" && c.header("x-user-tier") === "beta") {
        return true;
      }

      // A request-time KILL SWITCH: flip a shipped, on-by-default feature OFF for
      // everyone without a redeploy — dynamic OVERRIDING a static `true`.
      if (flag === "public-changelog" && c.header("x-kill-changelog") === "1") {
        return false;
      }

      // Anything else defers to its static default (and undeclared ⇒ off).
      return undefined;
    },
  });
}

/** A tiny HTML index so the hosted leg is browsable — links each route + its lever. */
function indexHtml(): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>@lesto/flags example</title></head><body>` +
    `<h1>@lesto/flags — gated routes</h1>` +
    `<ul>` +
    `<li><a href="/dashboard">/dashboard</a> — off by default (404); ` +
    `<a href="/dashboard?preview=1">?preview=1</a> flips it on</li>` +
    `<li><a href="/changelog">/changelog</a> — on by default (200); ` +
    `a <code>x-kill-changelog: 1</code> header kills it (404)</li>` +
    `<li><a href="/experiment">/experiment</a> — undeclared flag → always 404</li>` +
    `<li><a href="/beta/labs">/beta/labs</a> — beta subtree, off by default (404); ` +
    `<a href="/beta/labs?preview=1">?preview=1</a> opens it</li>` +
    `<li><a href="/flags">/flags</a> — the resolution table for this request</li>` +
    `</ul></body></html>`
  );
}

/**
 * The routes, gated by `flags`.
 *
 *   GET /              a browsable HTML index (for the hosted leg)
 *   GET /dashboard     gate("new-dashboard")        off ⇒ 404, lever ⇒ 200
 *   GET /changelog     gate("public-changelog")     on ⇒ 200, kill switch ⇒ 404
 *   GET /experiment    gate("unlaunched-experiment")always 404 (undeclared ⇒ off)
 *   GET /beta/*         .use(gate("beta"))          the whole subtree hidden when off
 *   GET /flags          flags.enabled(...) per flag  the resolution outcome, legible
 */
export function buildFlagsApp(flags: Flags): Lesto {
  // The beta subtree: ONE `.use(flags.gate("beta"))` hides EVERY route mounted
  // beneath it — the whole feature area disappears when the flag is off, not just
  // a single endpoint.
  const beta = lesto()
    .use(flags.gate("beta"))
    .get("/labs", (c) => c.json({ feature: "beta", area: "labs" }))
    .get("/labs/settings", (c) => c.json({ feature: "beta", area: "labs/settings" }));

  return (
    lesto()
      .get("/", (c) => c.html(indexHtml()))

      // The headline: a route gated on an OFF-by-default flag. Off ⇒ 404 (the
      // feature does not exist to a client), on ⇒ the handler runs.
      .get("/dashboard", flags.gate("new-dashboard"), (c) =>
        c.json({ feature: "new-dashboard", widgets: ["revenue", "signups", "latency"] }),
      )

      // A route gated on an ON-by-default flag: shipped, so it answers 200 for
      // everyone — until the request-time kill switch flips it off (then 404).
      .get("/changelog", flags.gate("public-changelog"), (c) =>
        c.json({ feature: "public-changelog", entries: ["0.1.2 — the flags gallery example"] }),
      )

      // Gated on an UNDECLARED flag (no default, never resolved): always off ⇒
      // always 404. The safe default — an unknown flag is off.
      .get("/experiment", flags.gate("unlaunched-experiment"), (c) =>
        c.json({ feature: "unlaunched-experiment" }),
      )

      // The beta subtree, mounted under /beta and gated as a WHOLE by the `.use`.
      .route("/beta", beta)

      // A diagnostic: report `flags.enabled(name, c)` for THIS exact request, so
      // the resolution outcome (dynamic vs static, unknown ⇒ off) is observable
      // directly, not inferred from a status code.
      .get("/flags", (c) =>
        c.json({
          "new-dashboard": flags.enabled("new-dashboard", c),
          "public-changelog": flags.enabled("public-changelog", c),
          beta: flags.enabled("beta", c),
          "unlaunched-experiment": flags.enabled("unlaunched-experiment", c),
        }),
      )
  );
}

/** What `buildApp` returns: the bare `@lesto/web` app run.ts / serve.ts / the test drive. */
export interface Booted {
  readonly app: Lesto;
}

/** Boot the flags app. No database — a flag decision is pure computation over the request. */
export function buildApp(): Booted {
  return { app: buildFlagsApp(buildFlags()) };
}
