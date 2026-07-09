/**
 * The Cloudflare Durable Object that makes `@lesto/pubsub` fan-out work ACROSS
 * isolates — a HIBERNATABLE WebSocket-terminating DO.
 *
 * On the edge every request may land on a different isolate with its own memory, so
 * an in-process hub can never see a publisher and a subscriber that hit different
 * isolates. With per-channel sharding (`worker.ts`), channel `X`'s subscribers and
 * publishers all route to `idFromName(X)` — this one instance is their rendezvous.
 *
 * This DO HIBERNATES: workerd may evict it from memory whenever no event is in
 * flight, so it can hold no in-memory registry of sockets. Instead every subscriber
 * socket is handed to `state.acceptWebSocket(server, [channel])`, which keeps it
 * alive across eviction and TAGS it with its channel; `state.getWebSockets(channel)`
 * is then the subscriber registry — enumerated fresh on each publish, even after the
 * DO woke from nothing. That is why the fan-out core is a pure {@link fanout} over an
 * injected socket list rather than a stateful hub: there is no surviving hub to hold.
 *
 * The per-channel `seq` lives in `state.storage` (durable), not memory: an in-memory
 * counter would rewind to 0 on every eviction, silently corrupting the ordering a
 * missed-message resume relies on.
 *
 * `WebSocketPair` + the hibernation methods are workerd runtime globals absent from
 * the DOM lib this example is typed against (see `tsconfig.json`), so their shapes
 * are declared locally rather than dragging the full workerd global surface in (the
 * `key-store.ts` lesson).
 */

import { fanout, parsePublishBody } from "@lesto/pubsub";

/** A WebSocket end from a {@link WebSocketPair}; workerd adds `serializeAttachment`. */
type ServerWebSocket = WebSocket & { serializeAttachment(value: unknown): void };

declare const WebSocketPair: { new (): { 0: WebSocket; 1: ServerWebSocket } };

/** The slim slice of workerd's `DurableObjectStorage` this DO uses. */
interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** The slim slice of workerd's `DurableObjectState` this DO uses (hibernation + storage). */
interface DurableObjectState {
  /** Accept `ws` into the hibernatable set, tagged so `getWebSockets(tag)` can find it. */
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  /** Every hibernatable socket, or only those carrying `tag`. */
  getWebSockets(tag?: string): WebSocket[];
  storage: DurableObjectStorage;
}

export class PubSubRoom {
  readonly #state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.#state = state;
  }

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

    // INVARIANT 2: register the socket BEFORE returning the 101. Under hibernation we
    // do NOT call `server.accept()` — `acceptWebSocket` puts the socket in workerd's
    // hibernatable set, TAGGED with its channel so `getWebSockets(channel)` enumerates
    // it after any eviction. The client's `open` fires only once it receives this 101,
    // so the socket is guaranteed registered before any post-open publish. Do not reorder.
    this.#state.acceptWebSocket(server, [channel]);

    // The channel survives eviction with the socket, so a woken DO still knows what
    // each hibernated socket is subscribed to (and a future resume can read it back).
    server.serializeAttachment({ channel });

    // `webSocket` on the response init is workerd-only (absent from the DOM
    // `ResponseInit`); the assertion passes it through at runtime.
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  async #publish(request: Request): Promise<Response> {
    // A non-JSON body rejects `.json()`; treat it as malformed → 400, not a 500.
    const body = parsePublishBody(await request.json().catch(() => undefined));

    if (body === undefined) {
      return new Response('expected { "channel": string, "message": <any> }', { status: 400 });
    }

    // DURABLE, monotonic, per-channel seq — an in-memory counter would rewind to 0
    // every time workerd evicts this hibernated DO (invariant 4).
    const key = `seq:${body.channel}`;
    const seq = ((await this.#state.storage.get<number>(key)) ?? 0) + 1;
    await this.#state.storage.put(key, seq);

    // The registry is the runtime: enumerate this channel's live sockets and fan out
    // over them with the pure core. workerd evicts a closed socket from the tag set,
    // so the list is current even after the DO woke from nothing.
    const { delivered } = fanout(this.#state.getWebSockets(body.channel), {
      type: "message",
      channel: body.channel,
      seq,
      data: body.message,
    });

    return Response.json({ delivered });
  }

  /** Subscribers never publish over the socket; ignore anything they send. */
  webSocketMessage(): void {
    // no-op
  }

  /** The client closed; finish the server side (workerd has already untagged it). */
  webSocketClose(ws: WebSocket): void {
    ws.close();
  }

  /** A socket errored; close it so it leaves the tag set. */
  webSocketError(ws: WebSocket): void {
    ws.close();
  }
}
