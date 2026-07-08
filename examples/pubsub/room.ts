/**
 * The Cloudflare Durable Object that makes `@lesto/pubsub` fan-out work ACROSS
 * isolates — the first WebSocket-terminating DO in the framework.
 *
 * On the edge every request may land on a different isolate with its own memory,
 * so an in-process `PubSub` can never see a publisher and a subscriber that hit
 * different isolates. A single named DO (see `worker.ts`) is the rendezvous: both
 * the `/subscribe` socket and the `/publish` request are routed to the ONE
 * instance, whose in-memory {@link FanoutRoom} is the same hub for both. That is
 * the whole demo — a message published by one connection reaches a socket opened
 * by another, through the DO.
 *
 * This is a NON-HIBERNATING DO on purpose: keeping the live `FanoutRoom` in memory
 * is the point of the demo. It holds no `state.storage` (ephemeral fan-out — a
 * missed-message `ReplayRing` is the documented graduation), so it needs no
 * constructor; workerd's `(state, env)` args to the default constructor are
 * ignored.
 *
 * `WebSocketPair` is a workerd runtime global absent from the DOM lib this example
 * is typed against (see `tsconfig.json`), so its shape is declared locally rather
 * than dragging the full workerd global surface in (the `key-store.ts` lesson).
 */

import { FanoutRoom, parsePublishBody } from "@lesto/pubsub";

/** A WebSocket end from a {@link WebSocketPair} — a DOM `WebSocket` plus workerd's server-only `accept()`. */
type ServerWebSocket = WebSocket & { accept(): void };

declare const WebSocketPair: { new (): { 0: ServerWebSocket; 1: ServerWebSocket } };

export class PubSubRoom {
  readonly #room = new FanoutRoom();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/subscribe") {
      return this.#subscribe(url);
    }

    if (url.pathname === "/publish" && request.method === "POST") {
      return this.#publish(request);
    }

    return new Response("not found", { status: 404 });
  }

  #subscribe(url: URL): Response {
    const channel = url.searchParams.get("channel");

    if (channel === null || channel.length === 0) {
      return new Response("missing ?channel", { status: 400 });
    }

    const { 0: client, 1: server } = new WebSocketPair();

    server.accept();

    // INVARIANT 2: register the socket BEFORE returning the 101. The client's
    // `open` fires only once it receives this response, so the socket is
    // guaranteed subscribed before any post-open publish can arrive — no
    // publish-races-subscribe gap. Do not reorder.
    const off = this.#room.add({ send: (data) => server.send(data) }, channel);

    server.addEventListener("close", off);
    server.addEventListener("error", off);

    // `webSocket` on the response init is workerd-only (absent from the DOM
    // `ResponseInit`); the assertion passes it through at runtime without pulling
    // workerd globals into this DOM-typed file.
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  async #publish(request: Request): Promise<Response> {
    // A non-JSON body rejects `.json()`; treat it as malformed → 400, not a 500.
    const body = parsePublishBody(await request.json().catch(() => undefined));

    if (body === undefined) {
      return new Response('expected { "channel": string, "message": <any> }', { status: 400 });
    }

    const delivered = await this.#room.publish(body.channel, body.message);

    return Response.json({ delivered });
  }
}
