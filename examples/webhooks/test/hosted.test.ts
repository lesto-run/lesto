/**
 * The REQUIRED end-to-end test for the rawBody seam (the anti-false-green).
 *
 * Every OTHER test in this example drives `/incoming` through the in-process
 * `app.handle` — which never decodes a body (`handle` assigns `body`/`rawBody`
 * straight from the caller's options, see `@lesto/web`'s `lesto.ts`), so those
 * tests would stay green even if the real edge decode never wired `rawBody`
 * through at all. This test instead proves the seam survives the REAL hosted
 * pipeline, with no server and no network:
 *
 *   1. wrap the SAME app in a real kernel `App` (`createApp`, secure defaults ON
 *      — the point is to prove `rawBody` survives the HARDENED pipeline, not a
 *      bypassed one);
 *   2. adapt it to a `fetch(Request) => Response` via `@lesto/cloudflare`'s
 *      `toFetchHandler` — the exact adapter a Cloudflare Worker's `fetch` export
 *      wires (see `examples/estate/worker.ts`);
 *   3. POST a genuinely-signed `Request` with `content-type: application/json`,
 *      so `toFetchHandler`'s `decodeBody` JSON-decodes the body into `c.req.body`
 *      AND preserves the exact bytes as `c.req.rawBody` — only that second field
 *      is what `/incoming` verifies against.
 *
 * If the `rawBody` seam ever regressed anywhere along that edge → kernel →
 * `app.handle` chain — `EdgeRequestOptions`/`Decoded` dropped the field,
 * `dispatchHardened` stopped forwarding it, or the kernel's inline `handle`
 * options type lost it — `c.req.rawBody` would be `undefined`, `/incoming`
 * would 400 before ever reaching `verifyRequest`, and THIS test would go red
 * even though every other test in this example stays green.
 */

import { describe, expect, it } from "vitest";

import { toFetchHandler } from "@lesto/cloudflare";
import { createApp } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@lesto/webhooks";

import { buildApp, SHARED_SECRET, type ReceivedWebhook } from "../src/app";

describe("@lesto/webhooks example — the hosted receiver over the real edge→kernel pipeline", () => {
  it("verifies a genuinely-signed request through toFetchHandler + createApp", async () => {
    const { db: handle, close } = await openSqlite();

    try {
      const booted = await buildApp({ handle });

      // Secure defaults ON (no `secure: false`): the kernel's rate-limit
      // baseline wraps every request exactly as a real deploy would.
      const kernelApp = await createApp({ db: handle, app: booted.app });
      const fetch = toFetchHandler((method, path, options) =>
        kernelApp.handle(method, path, options),
      );

      const raw = JSON.stringify({ event: "order.paid", data: { orderId: "ord_hosted" } });
      const ts = Date.now();
      const sig = sign(`${ts}.${raw}`, SHARED_SECRET);

      const res = await fetch(
        new Request("https://x/incoming", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: sig,
            [TIMESTAMP_HEADER]: String(ts),
          },
          body: raw,
        }),
      );

      // 200: the receiver verified the signature over `c.req.rawBody` — which
      // exists ONLY because the edge decode preserved the raw bytes all the way
      // through the kernel to `/incoming`'s handler.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ verified: true });

      // And the SIGNED payload was recorded — not just a 200 with an empty inbox.
      const list = await kernelApp.handle("GET", "/received");
      expect(JSON.parse(list.body as string) as ReceivedWebhook[]).toEqual([
        { event: "order.paid", data: { orderId: "ord_hosted" } },
      ]);
    } finally {
      close();
    }
  });
});
