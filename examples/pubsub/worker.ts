/**
 * The Cloudflare Worker entry for the pubsub edge demo.
 *
 *   bun alchemy.run.ts        # deploy → prints the live workers.dev url
 *
 * The stateful piece is the Durable Object (`room.ts`); this Worker is pure
 * routing. `/subscribe` and `/publish` are forwarded to ONE named DO instance
 * (`idFromName("hub")`), so a publisher and a subscriber that land on different
 * isolates still rendezvous at the same in-memory {@link FanoutRoom} — the
 * cross-isolate proof. `GET /` serves a tiny browser demo.
 *
 * Unlike the wave-1 cache/mail workers, there is no per-isolate memoized handler:
 * the app's only state lives in the DO, and the Worker forwards without building
 * anything. workerd resolves the `PubSubRoom` DO class from this entry's exports,
 * so it is re-exported below.
 *
 * A same-account `workers.dev → DO` forward is an INTERNAL subrequest (a Worker to
 * its own Durable Object), not the `workers.dev → workers.dev` public subrequest
 * CF error 1042 refuses — so no service binding is needed. The DOM-vs-workerd
 * `Request`/`Response` nominal mismatch on the stub's `fetch` is bridged with the
 * same `as unknown as typeof fetch` cast the MCP RS worker uses.
 */

import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export { PubSubRoom } from "./room";

interface Env {
  /** The Durable Object namespace the fan-out hub lives in (see alchemy.run.ts). */
  PUBSUB_ROOM: DurableObjectNamespace;
}

/** Forward a request to the single named hub DO instance. */
function forwardToHub(request: Request, env: Env): Promise<Response> {
  const ns = env.PUBSUB_ROOM;
  const stub = ns.get(ns.idFromName("hub"));

  return (stub.fetch.bind(stub) as unknown as typeof fetch)(request);
}

const DEMO_HTML = `<!doctype html>
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
      to it over plain HTTP. Every message is fanned out through the Durable Object.</p>
    <p><input id="msg" value="hello from the edge" size="30" /> <button id="send">publish</button></p>
    <div id="log">connecting…</div>
    <script>
      const log = document.getElementById("log");
      const line = (t) => { log.textContent += "\\n" + t; };
      const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/subscribe?channel=demo");
      ws.onopen = () => { log.textContent = "subscribed to #demo"; };
      ws.onmessage = (e) => { line("received: " + JSON.parse(e.data).data); };
      ws.onclose = () => line("disconnected");
      document.getElementById("send").onclick = async () => {
        const message = document.getElementById("msg").value;
        const res = await fetch("/publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel: "demo", message }),
        });
        line("published (delivered to " + (await res.json()).delivered + ")");
      };
    </script>
  </body>
</html>`;

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/subscribe" || url.pathname === "/publish") {
      return forwardToHub(request, env);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(DEMO_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return new Response("not found", { status: 404 });
  },
};
