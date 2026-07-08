/**
 * The mail app on the Cloudflare edge — delivers through Cloudflare Email
 * Sending's `send_email` binding (no API keys).
 *
 *   bun alchemy.run.ts        # deploy → prints the live workers.dev url
 *
 * The queue rides D1 (`d1ToSqlDatabase(env.DB)`); the transport is the platform
 * `EMAIL` binding wrapped by `@lesto/mail`'s `createCloudflareEmailTransport`.
 * Everything else is the shared `bootMail` wiring — the same app the Node
 * `serve.ts` and the test build, only the substrate + transport differ.
 *
 * ⚠️ A real send requires the `from` domain (`hello@lesto.run`) to be ONBOARDED
 * to Cloudflare Email Sending first (`wrangler email sending enable lesto.run` +
 * the SPF/DKIM/DMARC DNS records). Until then the binding rejects the send and
 * `POST /send` honestly reports `delivered: false` with the failure reason — it
 * does not pretend to have delivered. That onboarding is the one manual hop; what
 * the deploy asserts is narrower: the Worker boots and installs its D1 queue
 * schema (`GET /health` → 200). See `alchemy.run.ts`.
 */

import { d1ToSqlDatabase, toFetchHandler } from "@lesto/cloudflare";
import type { D1Database, EdgeExecutionContext } from "@lesto/cloudflare";
import { createCloudflareEmailTransport } from "@lesto/mail";
import type { CloudflareEmailBinding } from "@lesto/mail";

import { bootMail, DEFAULT_FROM } from "./src/app";

/** The bindings this Worker is configured with (see alchemy.run.ts). */
interface Env {
  /** The Cloudflare D1 database backing the mail queue. */
  readonly DB: D1Database;

  /** The Cloudflare Email Sending `send_email` binding. */
  readonly EMAIL: CloudflareEmailBinding;
}

type FetchHandler = (request: Request, ctx?: EdgeExecutionContext) => Promise<Response>;

let handler: Promise<FetchHandler> | undefined;

async function build(env: Env): Promise<FetchHandler> {
  const transport = createCloudflareEmailTransport({
    binding: env.EMAIL,
    defaultFrom: DEFAULT_FROM,
  });

  const { app } = await bootMail({
    handle: d1ToSqlDatabase(env.DB),
    transport,
    transportLabel: "cloudflare-email",
  });

  return toFetchHandler((method, path, options) => app.handle(method, path, options));
}

export default {
  async fetch(request: Request, env: Env, ctx?: EdgeExecutionContext): Promise<Response> {
    if (handler === undefined) {
      const building = build(env);

      // Clear the memo if the build rejects (e.g. a transient D1 blip during
      // schema install) so the isolate retries on the next request instead of
      // serving a cached rejected promise for its whole life. A per-request
      // error can't reach here — `toFetchHandler` always resolves a Response.
      void building.catch(() => {
        handler = undefined;
      });

      handler = building;
    }

    return (await handler)(request, ctx);
  },
};
