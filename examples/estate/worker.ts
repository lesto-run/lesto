/**
 * The Cloudflare Worker entry — the estate site on the edge.
 *
 *   wrangler deploy
 *
 * Keel's dispatcher is pure, so the Worker is a thin adapter (ADR 0002):
 * `toFetchHandler` turns the app's `handle` into `fetch(Request) => Response`,
 * and `withAssets` serves the prerendered marketing files from the Static Assets
 * binding first, falling through to the live app for `/mls`. The session is a
 * stateless signed token, so auth works across ephemeral isolates with no store.
 *
 * `env.SESSION_SECRET` is a wrangler secret (`wrangler secret put SESSION_SECRET`),
 * never committed — it is the trust root for every signed session.
 */

import { toFetchHandler, withAssets } from "@keel/cloudflare";
import type { AssetFetcher } from "@keel/cloudflare";

// The Preact server dialect. This import is only honest because wrangler bundles
// this worker with the react→preact/compat alias block (wrangler.jsonc): inside
// that bundle, every element @keel/ui builds is a Preact vnode, which is exactly
// what preact-render-to-string consumes. The matched pair — Preact server markup
// + the Preact client bundle `build.ts` ships — is ADR 0008's invariant.
import { preactServerRenderer } from "@keel/ui/server-preact";

import { buildEdgeApp, edgeSecret, isDemoMode } from "./src/edge";

/** The bindings this Worker is configured with (see wrangler.jsonc). */
interface Env {
  readonly ASSETS: AssetFetcher;
  readonly SESSION_SECRET?: string;
  readonly KEEL_DEMO?: string;
}

/** A Cloudflare Worker fetch handler — what both `toFetchHandler` and `withAssets` produce. */
type FetchHandler = (request: Request) => Promise<Response>;

/**
 * The app/handler is built once per isolate and reused across requests, not
 * rebuilt on every `fetch`. Constructing the `keel()` app and its
 * `SignedSessions` is pure CPU that depends on nothing but the signing secret,
 * so doing it per request burned cycles on the edge for an identical result
 * (research finding 11: keep work out of the per-request path). We memoize the
 * `toFetchHandler` closure at module scope, keyed by the resolved secret.
 *
 * Keying by secret is the correctness guard: a Worker's secret is fixed for an
 * isolate's lifetime, so the cache hits every time in production — but if the
 * resolved secret ever differs (a rotation, or a test that drives two secrets
 * through the same module), we rebuild rather than serve a handler signing with
 * the wrong key. There is no cross-secret leakage: a different secret is a miss.
 *
 * `env.ASSETS` is deliberately NOT part of what we cache. It is a per-request
 * binding the runtime hands us fresh on each `fetch`, so `withAssets` is rewrapped
 * every request around the cached handler — cheap composition, no rebuild.
 */
let cachedSecret: string | undefined;
let cachedDemo: boolean | undefined;
let cachedHandler: FetchHandler | undefined;

/**
 * The fetch handler for `secret` + `demo`, built once per isolate and reused.
 *
 * Keyed by both the secret and the demo flag: the demo flag changes whether the
 * passwordless `?as=` sign-in is reachable, so a flag change must rebuild rather
 * than serve a handler with the wrong auth posture.
 */
function handlerFor(secret: string, demo: boolean): FetchHandler {
  if (cachedHandler === undefined || cachedSecret !== secret || cachedDemo !== demo) {
    const app = buildEdgeApp(secret, { serverRenderer: preactServerRenderer, demo });

    cachedHandler = toFetchHandler((method, path, options) => app.handle(method, path, options));
    cachedSecret = secret;
    cachedDemo = demo;
  }

  return cachedHandler;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // edgeSecret FAILS CLOSED: an unset SESSION_SECRET outside demo mode throws
    // here, so the Worker refuses to serve rather than sign with a public secret.
    const handler = handlerFor(edgeSecret(env), isDemoMode(env));

    // Static marketing files first (cached at the PoP); the live app for the rest.
    // `env.ASSETS` is per-request, so this thin wrap happens every time; the
    // handler it wraps is the cached, isolate-lifetime one built above.
    return withAssets(env.ASSETS, handler)(request);
  },
};
