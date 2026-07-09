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
 * MISSED-MESSAGE RESUME: ephemeral fan-out drops any message a subscriber was offline
 * for, so each publish is also appended to a bounded per-channel `state.storage` sqlite
 * ring `(seq, channel, data, at)`. A subscriber that reconnects with `?since=<seq>` is
 * replayed every retained row `seq > since` BEFORE any live frame. A publish that
 * interleaves the replay may double-send a seq, so the contract is a floor, not
 * arithmetic: the CLIENT dedups by monotonic seq (ignore `seq <= lastSeen`) — always
 * correct. Below the retained window (`since` older than the oldest retained row) the
 * missed rows are simply gone; the client resumes from the live edge and, for anything
 * it must not miss, treats the gap as it would a cold start. The ring's *storage* is
 * here (SQL); its *eviction arithmetic* is `@lesto/pubsub`'s pure, 100%-covered
 * {@link replayEvictionBounds}.
 *
 * `WebSocketPair` + the hibernation methods are workerd runtime globals absent from
 * the DOM lib this example is typed against (see `tsconfig.json`), so their shapes
 * are declared locally rather than dragging the full workerd global surface in (the
 * `key-store.ts` lesson).
 */

import { encodeFrame, fanout, parsePublishBody, replayEvictionBounds } from "@lesto/pubsub";
import type { ReplayRetention } from "@lesto/pubsub";

/** A WebSocket end from a {@link WebSocketPair}; workerd adds `serializeAttachment`. */
type ServerWebSocket = WebSocket & { serializeAttachment(value: unknown): void };

declare const WebSocketPair: { new (): { 0: WebSocket; 1: ServerWebSocket } };

/** The slim slice of a workerd `SqlStorage` cursor this DO reads (see `getWebSockets`, the DOM-lib lesson). */
interface SqlStorageCursor<T> {
  toArray(): T[];
}

/** The slim slice of workerd's `SqlStorage` (the `sqlite: true` DO backend) this DO uses. */
interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
}

/** The slim slice of workerd's `DurableObjectStorage` this DO uses (durable seq KV + the ring's SQL). */
interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  sql: SqlStorage;
}

/** A retained ring row — the columns replay reads to rebuild a frame identical to the live one. */
interface RingRow {
  seq: number;
  channel: string;
  data: string;
}

/**
 * How much history each channel's replay ring keeps — bounded by BOTH count and age so
 * a hot channel cannot grow the ring without limit and a cold one cannot hold stale
 * rows forever. Demo-scale values; a production bus would tune (or make them per-app).
 */
const RING_RETENTION: ReplayRetention = { maxEntries: 256, maxAgeMs: 5 * 60_000 };

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

    // Create the replay ring lazily-but-eagerly: `CREATE TABLE IF NOT EXISTS` is
    // idempotent and cheap, so running it on every wake (the constructor fires each
    // time workerd rehydrates this hibernated DO) is simplest and always correct.
    // ONE statement per `exec` — multi-statement DDL passes locally (openSqlite) but
    // throws 7500 on remote DO-sqlite (the d1-single-statement-exec trap).
    this.#state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS ring (seq INTEGER PRIMARY KEY, channel TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL)",
    );
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

    // A workerd WebSocket tag is capped at 256 chars; a longer channel would make
    // `acceptWebSocket` throw (a 500 after the pair is created). Reject it as a 400 —
    // cheap hardening for the reusable WS-DO pattern (unreachable via this demo's
    // server-minted `demo`/`smoke` channels, but a real app mints arbitrary ones).
    if (channel.length > 256) {
      return new Response("channel too long (max 256)", { status: 400 });
    }

    // `?since=<seq>` opts this subscriber into a missed-message replay. A seq is a
    // non-negative integer; reject anything else LOUDLY (a client bug) rather than
    // silently replaying from 0 or nothing. Absent ⇒ a fresh subscribe (no replay).
    const sinceRaw = url.searchParams.get("since");
    if (sinceRaw !== null && !/^\d+$/.test(sinceRaw)) {
      return new Response("invalid ?since (expected a non-negative integer seq)", { status: 400 });
    }
    const sinceSeq = sinceRaw === null ? undefined : Number(sinceRaw);

    const { 0: client, 1: server } = new WebSocketPair();

    // INVARIANT 2: register the socket BEFORE returning the 101. Under hibernation we
    // do NOT call `server.accept()` — `acceptWebSocket` puts the socket in workerd's
    // hibernatable set, TAGGED with its channel so `getWebSockets(channel)` enumerates
    // it after any eviction. The client's `open` fires only once it receives this 101,
    // so the socket is guaranteed registered before any post-open publish. Do not reorder.
    this.#state.acceptWebSocket(server, [channel]);

    // The channel + resume cursor survive eviction with the socket, so a woken DO still
    // knows what each hibernated socket is subscribed to and from where it resumed.
    server.serializeAttachment({ channel, sinceSeq });

    // Replay the missed window BEFORE returning the 101, so every retained `seq > since`
    // is buffered onto the socket ahead of any live frame (a live publish is a separate
    // request that can still interleave — hence the client-side seq dedup floor). Each
    // replayed row rebuilds a frame byte-identical to what a live subscriber received.
    if (sinceSeq !== undefined) {
      const missed = this.#state.storage.sql
        .exec<RingRow>("SELECT seq, channel, data FROM ring WHERE seq > ? ORDER BY seq", sinceSeq)
        .toArray();

      for (const row of missed) {
        server.send(
          encodeFrame({
            type: "message",
            channel: row.channel,
            seq: row.seq,
            data: JSON.parse(row.data),
          }),
        );
      }
    }

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
    // every time workerd evicts this hibernated DO (invariant 4). This is the sole
    // owner of the seq: the ring is a bounded copy, never the counter (an evicted ring
    // would rewind MAX(seq), so seq is NOT derived from it).
    const key = `seq:${body.channel}`;
    const seq = ((await this.#state.storage.get<number>(key)) ?? 0) + 1;
    await this.#state.storage.put(key, seq);

    // Append to the replay ring so a subscriber that reconnects with `?since=` can catch
    // up, then evict what fell out of the bounded window. `data` stores the raw message
    // (not the whole frame) so a replay rebuilds a frame identical to the live one. Each
    // statement is a SEPARATE `exec` — multi-statement SQL throws 7500 on remote DO-sqlite.
    const at = Date.now();
    this.#state.storage.sql.exec(
      "INSERT INTO ring (seq, channel, data, at) VALUES (?, ?, ?, ?)",
      seq,
      body.channel,
      JSON.stringify(body.message),
      at,
    );
    const bounds = replayEvictionBounds(seq, at, RING_RETENTION);
    this.#state.storage.sql.exec("DELETE FROM ring WHERE seq <= ?", bounds.seqAtOrBelow);
    this.#state.storage.sql.exec("DELETE FROM ring WHERE at < ?", bounds.agedOutBefore);

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
