/**
 * The Cloudflare Worker entry for the pubsub edge demo.
 *
 *   bun alchemy.run.ts        # deploy → prints the live workers.dev url
 *
 * The stateful piece is the Durable Object (`room.ts`); this Worker is the routing +
 * authz boundary. Every request carries a signed capability token (see
 * `@lesto/pubsub`'s `channel-token.ts`); the Worker VERIFIES it before forwarding
 * anything to a DO — a wrong-channel, wrong-mode, expired, or forged token is `401`ed
 * here, so the DO is never touched by an unauthorized caller.
 *
 * Routing is now PER CHANNEL: `/subscribe` and `/publish` for channel `X` are both
 * forwarded to `idFromName(X)`, so a publisher and a subscriber that land on
 * different isolates still rendezvous at the SAME DO instance (the cross-isolate
 * proof), while different channels get different DOs (lifting the single-instance
 * throughput ceiling). `GET /` is the token ISSUER: it mints short-lived subscribe +
 * publish tokens for the `demo` channel and serves a tiny browser demo — modelling
 * "the authenticated backend that renders your page hands out the capability". There
 * is no open mint endpoint.
 *
 * A same-account `workers.dev → DO` forward is an INTERNAL subrequest (a Worker to
 * its own Durable Object), not the `workers.dev → workers.dev` public subrequest CF
 * error 1042 refuses — so no service binding is needed. The DOM-vs-workerd
 * `Request`/`Response` nominal mismatch on the stub's `fetch` is bridged with the
 * same `as unknown as typeof fetch` cast the MCP RS worker uses.
 */

import { mintChannelToken, parsePublishBody, verifyChannelToken } from "@lesto/pubsub";
import type { ChannelMode } from "@lesto/pubsub";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export { PubSubRoom } from "./room";

interface Env {
  /** The Durable Object namespace the fan-out hub lives in (see alchemy.run.ts). */
  PUBSUB_ROOM: DurableObjectNamespace;

  /** The HMAC secret capability tokens are signed + verified with (see alchemy.run.ts). */
  PUBSUB_SECRET: string;
}

/** How long the demo page's minted tokens stay valid — long enough to click around. */
const DEMO_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Forward a request to the DO instance for `channel` (per-channel sharding). */
function forwardToChannel(request: Request, env: Env, channel: string): Promise<Response> {
  const ns = env.PUBSUB_ROOM;
  const stub = ns.get(ns.idFromName(channel));

  return (stub.fetch.bind(stub) as unknown as typeof fetch)(request);
}

/**
 * Pull a capability token off a request: `Authorization: Bearer <t>` first (an HTTP
 * publisher), else the `?token=` query (a browser WebSocket upgrade, which cannot set
 * headers). `""` when absent — {@link verifyChannelToken} rejects that as `malformed`.
 */
function readToken(request: Request, url: URL): string {
  const authorization = request.headers.get("authorization");

  if (authorization?.startsWith("Bearer ") === true) {
    return authorization.slice("Bearer ".length);
  }

  return url.searchParams.get("token") ?? "";
}

/** Verify a `(channel, mode)` token; a `401` Response on failure, `undefined` when it passes. */
async function guard(
  request: Request,
  url: URL,
  channel: string,
  mode: ChannelMode,
  env: Env,
): Promise<Response | undefined> {
  const result = await verifyChannelToken(
    readToken(request, url),
    { channel, mode },
    env.PUBSUB_SECRET,
  );

  if (!result.ok) {
    return new Response(`unauthorized: ${result.reason}`, { status: 401 });
  }

  return undefined;
}

/** The browser demo, parameterised by the tokens `GET /` mints for the `demo` channel. */
function demoHtml(subscribeToken: string, publishToken: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>@lesto/pubsub — edge fan-out</title>
    <style>
      body { font: 15px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
      #log { border: 1px solid #ccc; border-radius: 6px; padding: .75rem; min-height: 8rem; white-space: pre-wrap; }
      input, button { font: inherit; padding: .4rem .6rem; }
    </style>
  </head>
  <body>
    <h1>@lesto/pubsub on the edge</h1>
    <p>A WebSocket subscribes to the <code>demo</code> channel; the button publishes
      to it over plain HTTP. Every message is fanned out through the Durable Object.
      Both requests carry a short-lived capability token this page minted for you.</p>
    <p><input id="msg" value="hello from the edge" size="30" /> <button id="send">publish</button></p>
    <div id="log">connecting…</div>
    <script>
      const SUBSCRIBE_TOKEN = ${JSON.stringify(subscribeToken)};
      const PUBLISH_TOKEN = ${JSON.stringify(publishToken)};
      const log = document.getElementById("log");
      const line = (t) => { log.textContent += "\\n" + t; };
      const wsBase = location.origin.replace(/^http/, "ws");
      const ws = new WebSocket(wsBase + "/subscribe?channel=demo&token=" + encodeURIComponent(SUBSCRIBE_TOKEN));
      ws.onopen = () => { log.textContent = "subscribed to #demo"; };
      ws.onmessage = (e) => { line("received: " + JSON.parse(e.data).data); };
      ws.onclose = () => line("disconnected");
      document.getElementById("send").onclick = async () => {
        const message = document.getElementById("msg").value;
        const res = await fetch("/publish", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + PUBLISH_TOKEN },
          body: JSON.stringify({ channel: "demo", message }),
        });
        line("published (delivered to " + (await res.json()).delivered + ")");
      };
    </script>
  </body>
</html>`;
}

/** Route `/subscribe` (query channel) — verify a subscribe token, then forward to the channel's DO. */
async function handleSubscribe(request: Request, url: URL, env: Env): Promise<Response> {
  const channel = url.searchParams.get("channel");

  if (channel === null || channel.length === 0) {
    return new Response("missing ?channel", { status: 400 });
  }

  const denied = await guard(request, url, channel, "subscribe", env);
  if (denied !== undefined) {
    return denied;
  }

  return forwardToChannel(request, env, channel);
}

/**
 * Route `/publish` — the body is read ONCE as text (a `Request` body is single-read)
 * to learn the channel for routing + authz, then a reconstructed request carrying
 * that body is forwarded to the channel's DO.
 */
async function handlePublish(request: Request, url: URL, env: Env): Promise<Response> {
  const text = await request.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  const body = parsePublishBody(parsed);
  if (body === undefined) {
    return new Response('expected { "channel": string, "message": <any> }', { status: 400 });
  }

  const denied = await guard(request, url, body.channel, "publish", env);
  if (denied !== undefined) {
    return denied;
  }

  const forwarded = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: text,
  });

  return forwardToChannel(forwarded, env, body.channel);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/subscribe") {
      return handleSubscribe(request, url, env);
    }

    if (url.pathname === "/publish" && request.method === "POST") {
      return handlePublish(request, url, env);
    }

    if (request.method === "GET" && url.pathname === "/") {
      const exp = Date.now() + DEMO_TOKEN_TTL_MS;
      const [subscribeToken, publishToken] = await Promise.all([
        mintChannelToken({ channel: "demo", mode: "subscribe", exp }, env.PUBSUB_SECRET),
        mintChannelToken({ channel: "demo", mode: "publish", exp }, env.PUBSUB_SECRET),
      ]);

      return new Response(demoHtml(subscribeToken, publishToken), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("not found", { status: 404 });
  },
};
