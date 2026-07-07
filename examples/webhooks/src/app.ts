/**
 * examples/webhooks — @lesto/webhooks outbound + inbound behind real HTTP routes.
 *
 * One app plays both sides of a webhook exchange:
 *
 *   OUTBOUND (`POST /orders`) — an order is placed and a signed `order.paid`
 *   webhook is `hooks.send(...)` to the customer's registered endpoint. The send
 *   is a `@lesto/queue` job: signed with HMAC-SHA256 over `${timestamp}.${body}`,
 *   SSRF-guarded, and retried until the receiver returns 2xx. The raw secret never
 *   enters the queue — only a `secretId` reference, resolved at delivery time.
 *
 *   INBOUND (`POST /incoming`) — the receiver `verifyRequest()`s that signature
 *   over `c.req.rawBody` (with the timestamp, so a stale replay is rejected)
 *   before recording the event. `GET /received` reads what was accepted.
 *
 * The delivery is dispatched IN-PROCESS by an injected `FetchLike` that hands the
 * exact signed bytes straight to `/incoming` as `rawBody` — no network, no ports.
 * This is the SAME seam a hosted receiver rides: `c.req.rawBody` is populated by
 * every transport (`@lesto/web`'s in-process `handle`, `@lesto/runtime`'s node
 * server, `@lesto/cloudflare`'s edge decode) — see `serve.ts`, which serves this
 * exact app over a real `node:http` server, and `test/hosted.test.ts`, which
 * proves the seam survives the real edge→kernel→handle chain via
 * `toFetchHandler`. Formerly this hosted leg was blocked on a `rawBody` seam
 * (see the README's DX finding #1, now RESOLVED).
 *
 * The SSRF guard is the REAL default (`defaultUrlGuard`); only DNS is injected (a
 * deterministic resolver that maps the demo host to a public IP), so a subscriber
 * URL pointing at a private/metadata address is refused with no real network.
 */

import { installSchema, Queue } from "@lesto/queue";
import type { JsonValue, SqlDatabase } from "@lesto/queue";
import { lesto } from "@lesto/web";
import type { Lesto } from "@lesto/web";
import { verifyRequest, Webhooks } from "@lesto/webhooks";
import type { FetchLike, Resolver, SecretSource } from "@lesto/webhooks";

/** The customer's registered endpoint host — the happy-path delivery target. */
export const RECEIVER_HOST = "hooks.example.com";

/** The full receiver URL an order webhook is delivered to in the happy path. */
export const RECEIVER_URL = `https://${RECEIVER_HOST}/incoming`;

/** The reference the sender persists; resolved to the real secret at delivery time. */
const SECRET_ID = "endpoint-1";

/**
 * The shared signing secret. In production the sender's `SecretSource` and the
 * receiver agree on this out of band; here both sides use the same constant, and
 * the test signs against it to forge / replay inbound requests.
 */
export const SHARED_SECRET = "whsec_demo_ada";

/** A webhook the receiver verified and accepted. */
export interface ReceivedWebhook {
  readonly event: string;
  readonly data: unknown;
}

/** What `Webhooks` is missing to sign anything is the secrets source: here it is. */
const secrets: SecretSource = (id) => (id === SECRET_ID ? SHARED_SECRET : undefined);

/**
 * A deterministic resolver so the SSRF guard runs WITHOUT real DNS: the demo host
 * resolves to a public address (allowed); anything else resolves to nothing,
 * which the guard treats as "did not resolve" and blocks. Literal private IPs
 * (e.g. the cloud metadata address) are judged by the guard directly and never
 * reach this resolver.
 */
const publicOnlyResolver: Resolver = async (host) =>
  host === RECEIVER_HOST ? ["93.184.216.34"] : [];

/** The routes, closing over the outbound `hooks`, the receiver secret, and the log. */
export function buildWebhooksApp(deps: {
  hooks: Webhooks;
  receiverSecret: string;
  received: ReceivedWebhook[];
}): Lesto {
  const { hooks, receiverSecret, received } = deps;

  return lesto()
    .post("/orders", async (c) => {
      const body = c.req.body as {
        orderId?: unknown;
        amountCents?: unknown;
        subscriberUrl?: unknown;
      } | null;

      if (
        typeof body?.orderId !== "string" ||
        typeof body.amountCents !== "number" ||
        typeof body.subscriberUrl !== "string"
      ) {
        return c.json(
          {
            error: "`orderId` (string), `amountCents` (number), `subscriberUrl` (string) required.",
          },
          422,
        );
      }

      const data: JsonValue = { orderId: body.orderId, amountCents: body.amountCents };

      // Enqueue a signed delivery. `secretId` is a REFERENCE — the raw secret is
      // resolved at delivery time and never written to the queue row. maxAttempts
      // 1 keeps the demo deterministic; a real deploy leaves the retried default.
      const jobId = await hooks.send(body.subscriberUrl, "order.paid", data, {
        secretId: SECRET_ID,
        maxAttempts: 1,
      });

      return c.json({ orderId: body.orderId, enqueued: jobId }, 202);
    })
    .post("/incoming", (c) => {
      // Read the RAW bytes — `c.req.rawBody`, never the JSON-decoded `c.req.body`
      // — so `verifyRequest` hashes exactly what the deliverer signed. Every
      // transport (in-process `handle`, `@lesto/runtime`'s node server,
      // `@lesto/cloudflare`'s edge decode) populates it; its absence means the
      // request carried no body at all.
      const rawBody = c.req.rawBody;
      if (rawBody === undefined) {
        return c.json({ error: "raw body required to verify the signature." }, 400);
      }

      // `verifyRequest` reads the signature/timestamp headers, does the
      // constant-time HMAC + replay-window check, and tells apart WHY a request
      // failed (missing/malformed/stale/mismatched) — see `@lesto/webhooks`.
      const result = verifyRequest(
        { body: rawBody, headers: c.req.headers },
        { secret: receiverSecret },
      );

      if (!result.verified) {
        return c.json({ verified: false, reason: result.reason }, 401);
      }

      // `result.event` already comes from the SIGNED body (never the unsigned
      // `x-lesto-event` header) — re-parse only for `data`, which `verifyRequest`
      // doesn't return.
      const parsed = JSON.parse(rawBody) as { event: string; data: unknown };
      received.push({ event: result.event ?? parsed.event, data: parsed.data });

      return c.json({ verified: true }, 200);
    })
    .get("/received", (c) => c.json(received));
}

/** What `buildApp` returns: the app plus the handles run.ts / the test need. */
export interface Booted {
  readonly app: Lesto;
  readonly queue: Queue;
  readonly hooks: Webhooks;
  readonly received: ReceivedWebhook[];

  /**
   * Every URL the deliverer actually TRIED to connect to (the injected fetch is
   * the only network hop). The SSRF guard runs BEFORE fetch, so a blocked URL
   * never appears here — which is how a test proves the guard refused a private
   * destination *before any connection*, not merely that delivery failed.
   */
  readonly fetchAttempts: string[];
}

export interface BuildOptions {
  /** A SQL database handle (from `@lesto/runtime`'s `openSqlite`). */
  readonly handle: SqlDatabase;
}

/**
 * Boot the webhooks app: install the queue schema, stand up the queue + a
 * `Webhooks` sender whose delivery is dispatched in-process to this app's own
 * receiver, wire the routes, and hand back the pieces run.ts / the test drive.
 *
 * The single `handle` flows straight into `installSchema` and the `Queue` — the
 * `@lesto/queue` SQL seam is exactly `@lesto/runtime`'s SQLite handle shape, so
 * there is no adapter and no cast.
 */
export async function buildApp(options: BuildOptions): Promise<Booted> {
  const { handle } = options;

  await installSchema(handle);

  const queue = new Queue({ db: handle });
  const received: ReceivedWebhook[] = [];
  const fetchAttempts: string[] = [];

  // The delivery fetch dispatches into THIS app's `/incoming` route in-process,
  // passing the exact signed bytes as `rawBody` — the field `/incoming` actually
  // reads to verify the signature — so the raw string survives. A holder breaks
  // the cycle: the fetch is only ever called during a queue drain, long after
  // `holder.app` is assigned.
  const holder: { app?: Lesto } = {};
  const dispatchFetch: FetchLike = async (url, init) => {
    if (holder.app === undefined) throw new Error("receiver app is not ready yet");

    // Record the connection attempt. Reaching here at all means the SSRF guard
    // ALLOWED this URL — a blocked URL throws in `deliver` before fetch is called.
    fetchAttempts.push(url);

    const res = await holder.app.handle("POST", new URL(url).pathname, {
      headers: init.headers,
      rawBody: init.body,
    });

    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  };

  const hooks = new Webhooks({
    queue,
    fetch: dispatchFetch,
    resolver: publicOnlyResolver,
    secrets,
  });

  const app = buildWebhooksApp({ hooks, receiverSecret: SHARED_SECRET, received });
  holder.app = app;

  return { app, queue, hooks, received, fetchAttempts };
}
