/**
 * Deploy the pubsub edge demo to Cloudflare with Alchemy (ADR 0044) — TypeScript
 * IaC, no `wrangler.toml`. Run it to deploy:
 *
 *   bunx alchemy login            # one-time: Alchemy needs its OWN CF creds
 *   bun alchemy.run.ts            # deploy   → prints the live url
 *   bun alchemy.run.ts --destroy  # tear down
 *
 * A single Worker (`worker.ts`) bound to a Durable Object namespace whose class is
 * `PubSubRoom` (`room.ts`) plus a `PUBSUB_SECRET` (the HMAC key capability tokens are
 * signed + verified with). Routing is PER CHANNEL: a subscriber's WebSocket and a
 * publisher's HTTP request for channel `X` are both routed to `idFromName(X)`, so
 * they rendezvous at the same hibernatable DO (the cross-isolate proof) while
 * different channels get different DOs.
 *
 * After `finalize()`, two post-deploy smokes run against the live url. The first opens
 * a REAL WebSocket (presenting a minted subscribe token), publishes a fresh random
 * nonce over a SEPARATE HTTP request (presenting a publish token), and asserts the
 * subscriber receives it — a falsifiable, DO-mediated cross-connection proof that ALSO
 * exercises the authz path. The second proves MISSED-MESSAGE RESUME: a subscriber
 * records a live message's seq, disconnects, a second message is published while it is
 * offline, and a fresh connection with `?since=<seq>` receives that missed message from
 * the durable replay ring. Together they make `bun alchemy.run.ts` the mechanical "it
 * deploys AND authorized fan-out + resume work on the edge" gate CI runs on every push.
 *
 * `nodejs_compat` is intentionally omitted: `@lesto/pubsub` is dependency-free, the
 * `fanout` core is pure, `channel-token` signs over Web Crypto (`crypto.subtle`, a
 * workerd global), and the DO uses only workerd globals — no node builtins.
 */

import { mintChannelToken } from "@lesto/pubsub";
import alchemy from "alchemy";
import { DurableObjectNamespace, Worker } from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";

// Shared deploy state in a Cloudflare-Durable-Object-backed SQLite store (ADR 0044 D5), encrypted
// under `ALCHEMY_STATE_TOKEN` (the SAME value across every adopting environment — D4), so CI and a
// teammate's machine adopt + tear down the SAME resources instead of orphaning them.
const app = await alchemy("lesto-example-pubsub", {
  stateStore: (scope) =>
    new CloudflareStateStore(scope, {
      forceUpdate: process.env.ALCHEMY_STATE_FORCE_UPDATE === "1",
    }),
});

// The token signing key. Required — the Worker verifies every subscribe/publish
// against it, so deploying without it would ship a bus that refuses everything.
const pubsubSecret = process.env.PUBSUB_SECRET;
if (pubsubSecret === undefined || pubsubSecret === "") {
  throw new Error(
    "PUBSUB_SECRET must be set to deploy the pubsub edge demo (the capability-token signing key)",
  );
}

const worker = await Worker("pubsub-edge", {
  name: `${app.name}-${app.stage}`,
  entrypoint: "worker.ts",
  bindings: {
    // `sqlite: true` is load-bearing: the hibernatable DO writes a durable per-channel
    // `seq:<channel>` to `state.storage` on every publish (so seq survives eviction),
    // and it is the hook for a future `state.storage`-backed ReplayRing.
    PUBSUB_ROOM: DurableObjectNamespace("pubsub-room", { className: "PubSubRoom", sqlite: true }),
    // Encrypted at rest in Alchemy state; the Worker verifies capability tokens with it.
    PUBSUB_SECRET: alchemy.secret(pubsubSecret),
  },
  url: true,
  compatibilityDate: "2025-06-01",
});

const url = worker.url;
if (url === undefined) throw new Error("pubsub Worker has no url (expected `url: true`)");

console.log("pubsub edge:", url);
console.log("  GET  ", url);
console.log("  WS   ", `${url}/subscribe?channel=<name>`);
console.log("  POST ", `${url}/publish   {"channel":"<name>","message":<any>}`);

await app.finalize();

await verifyLive(url, pubsubSecret);
await verifyResume(url, pubsubSecret);

/**
 * Post-deploy smoke: a real WebSocket subscriber receives a fresh nonce published
 * by a separate HTTP request, through the DO. The nonce is random per run, so the
 * assertion can genuinely fail — it is not a tautology. Both legs present a minted
 * capability token (subscribe on the WS url, publish in the `Authorization` header),
 * so this also proves the authz path admits a valid token. The WS connect is retried
 * with backoff to absorb cold start + the brief propagation window after a fresh
 * deploy; a persistent failure fails the deploy loudly rather than shipping a
 * broken Worker.
 */
async function verifyLive(base: string, secret: string): Promise<void> {
  const channel = "smoke";
  const nonce = crypto.randomUUID();
  const exp = Date.now() + 60_000;
  const subscribeToken = await mintChannelToken({ channel, mode: "subscribe", exp }, secret);
  const publishToken = await mintChannelToken({ channel, mode: "publish", exp }, secret);
  const wsUrl = `${base.replace(/^http/, "ws")}/subscribe?channel=${channel}&token=${encodeURIComponent(subscribeToken)}`;

  const ws = await openWithRetry(wsUrl);

  // Attach the receipt listener BEFORE publishing so no frame can be missed.
  const received = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error("smoke: subscriber never received the published nonce → fan-out broken")),
      10_000,
    );

    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String((event as MessageEvent).data)) as {
        data?: { nonce?: string };
      };

      if (frame.data?.nonce === nonce) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const publish = await fetch(`${base}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${publishToken}` },
    body: JSON.stringify({ channel, message: { nonce } }),
  });

  if (!publish.ok) {
    throw new Error(`smoke: POST /publish returned ${publish.status}`);
  }

  await received;

  ws.close();

  // Prove the REJECT path on the live edge too: a tokenless publish must be refused
  // (401) BEFORE the DO is touched — so "admitted only with a valid token" is
  // machine-checked, not merely asserted for the happy path.
  const unauthorized = await fetch(`${base}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, message: { nonce: "unauthorized" } }),
  });

  if (unauthorized.status !== 401) {
    throw new Error(
      `smoke: tokenless /publish returned ${unauthorized.status}, expected 401 → authz not enforced on the edge`,
    );
  }

  console.log(
    `smoke: DO-mediated fan-out — subscriber received nonce ${nonce} ✓; tokenless publish refused (401) ✓`,
  );
}

/** A framed pubsub message as it arrives on the wire (only the fields the smokes read). */
interface SmokeFrame {
  seq: number;
  data?: { nonce?: string };
}

/**
 * Post-deploy smoke for MISSED-MESSAGE RESUME (Task C). A subscriber connects, receives
 * a live message, and records the seq it was assigned; it disconnects; a SECOND message
 * is published while it is offline (so it can only ever reach the ring, never a live
 * socket); a fresh connection presents `?since=<recorded seq>` and must receive the
 * missed message from the durable replay ring. The nonces are random per run and each
 * wait matches THIS run's nonce (ignoring any concurrent run on the shared channel), so
 * it is genuinely falsifiable — a broken ring never replays the offline message and the
 * deploy fails loudly rather than shipping a resume that silently drops history.
 */
async function verifyResume(base: string, secret: string): Promise<void> {
  const channel = "resume-smoke";
  const exp = Date.now() + 60_000;
  const subscribeToken = await mintChannelToken({ channel, mode: "subscribe", exp }, secret);
  const publishToken = await mintChannelToken({ channel, mode: "publish", exp }, secret);
  const wsBase = base.replace(/^http/, "ws");

  const subscribeUrl = (sinceSeq?: number): string => {
    const query = new URLSearchParams({ channel, token: subscribeToken });
    if (sinceSeq !== undefined) query.set("since", String(sinceSeq));
    return `${wsBase}/subscribe?${query.toString()}`;
  };
  const publish = async (nonce: string): Promise<void> => {
    const res = await fetch(`${base}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${publishToken}` },
      body: JSON.stringify({ channel, message: { nonce } }),
    });
    if (!res.ok) throw new Error(`resume smoke: POST /publish returned ${res.status}`);
  };

  const onlineNonce = crypto.randomUUID();
  const offlineNonce = crypto.randomUUID();

  // 1) Subscribe live, publish the "online" nonce, and record the seq it was assigned.
  const sub1 = await openWithRetry(subscribeUrl());
  const onlineFrame = awaitFrame(sub1, (f) => f.data?.nonce === onlineNonce, "the live nonce");
  await publish(onlineNonce);
  const lastSeq = (await onlineFrame).seq;
  sub1.close();

  // 2) Publish the "offline" nonce with that subscriber gone → it lands ONLY in the ring.
  await publish(offlineNonce);

  // 3) Reconnect with `?since=<lastSeq>` — the ring must replay the message missed while
  //    offline, and it can arrive by NO other path (it was published before this connect).
  const sub2 = await openWithRetry(subscribeUrl(lastSeq));
  const missedFrame = await awaitFrame(
    sub2,
    (f) => f.data?.nonce === offlineNonce,
    "the missed nonce via ?since replay",
  );
  sub2.close();

  console.log(
    `resume smoke: message at seq ${missedFrame.seq}, published while offline, caught up via ?since=${lastSeq} ✓`,
  );
}

/**
 * Resolve with the first frame satisfying `match`, or reject after 10s. Frames that do
 * not match (e.g. a concurrent run's nonce on the shared channel) are ignored, so the
 * wait is specific to this run and still falsifiable — a path that never delivers the
 * awaited frame times out and fails the deploy.
 */
function awaitFrame(
  ws: WebSocket,
  match: (frame: SmokeFrame) => boolean,
  label: string,
): Promise<SmokeFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`resume smoke: never received ${label} → resume broken`)),
      10_000,
    );

    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String((event as MessageEvent).data)) as SmokeFrame;

      if (match(frame)) {
        clearTimeout(timer);
        resolve(frame);
      }
    });
  });
}

/** Open a WebSocket, resolving when it opens and rejecting if it errors first. */
function openSocket(target: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);

    ws.addEventListener("open", () => resolve(ws));
    // Log the path only, never the full target — it carries the `?token=` capability.
    ws.addEventListener("error", () =>
      reject(new Error(`WebSocket connect to ${target.split("?")[0]} failed`)),
    );
  });
}

/** Connect with backoff — a fresh deploy's isolate + DO may need a moment to come up. */
async function openWithRetry(target: string): Promise<WebSocket> {
  const delaysMs = [500, 1000, 2000, 4000, 8000];

  for (const [attempt, delayMs] of delaysMs.entries()) {
    try {
      return await openSocket(target);
    } catch {
      console.log(
        `smoke: WS ${target.split("?")[0]} not ready (attempt ${attempt + 1}); retrying in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Final attempt — let a persistent failure throw and fail the deploy.
  return openSocket(target);
}
