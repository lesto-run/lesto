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
 * ring `(channel, seq, data, at)`. A subscriber that reconnects with `?since=<seq>` is
 * replayed every retained row `seq > since` BEFORE any live frame. A publish that
 * interleaves the replay can double-send a seq, so a CORRECT CLIENT MUST dedup by
 * monotonic seq (ignore `seq <= lastSeen`) — the app owns this floor; the demo's browser
 * client does not. Below the retained window (`since` older than the oldest retained row)
 * the missed rows are gone for good: this ring is a bounded per-channel-DO buffer, not a
 * durable log, and — unlike `@lesto/realtime`, whose reconnect resyncs by refetching the
 * source DB — there is no source to refetch and the server sends NO gap/resync marker. A
 * client that must not miss a message therefore has to detect the hole itself (its first
 * replayed `seq > since + 1`) and recover. The ring's *storage* is here (SQL); its
 * *eviction arithmetic* is `@lesto/pubsub`'s pure, 100%-covered {@link replayEvictionBounds}.
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

/** A retained ring row as replay reads it — `seq` + the raw message; `channel` is the in-scope subscribe channel. */
interface RingRow {
  seq: number;
  data: string;
}

/**
 * How much history each channel's replay ring keeps — bounded by BOTH count and age so
 * a hot channel cannot grow the ring without limit and a cold one cannot hold stale
 * rows forever. Demo-scale values; a production bus would tune (or make them per-app).
 */
const RING_RETENTION: ReplayRetention = { maxEntries: 256, maxAgeMs: 5 * 60_000 };

/**
 * The most bytes a subscriber may have queued-but-unsent before it is treated as a slow
 * consumer and closed (backpressure). A healthy client drains far below this; a socket
 * that lets 1 MiB pile up is stuck, so we close it rather than buffer without bound.
 * Demo-scale; a production bus would tune it (or make it per-app).
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

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
    //
    // Keyed on `(channel, seq)`, NOT a bare `seq`: seq is per-channel (`seq:<channel>`),
    // so under this demo's one-channel-per-DO sharding each table holds a single channel
    // — but if two channels ever share a DO (the tag-based fan-out stays correct if
    // sharding is reverted, per Task B), a bare-`seq` PK would collide across channels
    // (a publish 500) and the channel-less reads below would leak/evict across channels.
    // Every ring statement is therefore channel-scoped, matching the per-channel seq.
    this.#state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS ring (channel TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (channel, seq))",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/subscribe") {
      return this.#subscribe(request, url);
    }

    if (url.pathname === "/publish" && request.method === "POST") {
      return this.#publish(request);
    }

    return new Response("not found", { status: 404 });
  }

  #subscribe(request: Request, url: URL): Response {
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

    // workerd rejects a 101 + `webSocket` response to a request that never asked to
    // upgrade — a bare GET (address-bar hit, health check) would otherwise mint a
    // `WebSocketPair` it can never use and surface as an opaque 500. Reject it as a
    // clean 426 before minting the pair (parity with the Bun path's `server.upgrade`
    // returning false in `app.ts`).
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();

    // INVARIANT 2: register the socket BEFORE returning the 101. Under hibernation we
    // do NOT call `server.accept()` — `acceptWebSocket` puts the socket in workerd's
    // hibernatable set, TAGGED with its channel so `getWebSockets(channel)` enumerates
    // it after any eviction. The client's `open` fires only once it receives this 101,
    // so the socket is guaranteed registered before any post-open publish. Do not reorder.
    this.#state.acceptWebSocket(server, [channel]);

    // Persist the channel + resume cursor WITH the socket (survives hibernation). Nothing
    // reads it back today — fan-out enumerates by workerd tag and replay is a one-shot at
    // connect — so this is a forward-looking hook for a future wake-time re-resume, not a
    // capability in use now (re-replaying on wake would only re-send frames the client
    // already deduped).
    server.serializeAttachment({ channel, sinceSeq });

    // Replay the missed window BEFORE returning the 101, so every retained `seq > since`
    // is buffered onto the socket ahead of any live frame (a live publish is a separate
    // request that can still interleave — hence the client-side seq dedup floor). Each
    // replayed row rebuilds a frame byte-identical to what a live subscriber received.
    // NOTE: replay is bounded by COUNT (≤ the ring's retained rows), not by the outbound
    // BYTE bound — a large backlog can transiently exceed `MAX_BUFFERED_BYTES`; the next
    // `#publish` fan-out then reaps the socket (1013 → reconnect → resume), so it is
    // self-correcting, not unbounded. Byte-bounding the replay itself is a future refinement.
    if (sinceSeq !== undefined) {
      const missed = this.#state.storage.sql
        .exec<RingRow>(
          "SELECT seq, data FROM ring WHERE channel = ? AND seq > ? ORDER BY seq",
          channel,
          sinceSeq,
        )
        .toArray();

      for (const row of missed) {
        server.send(
          encodeFrame({ type: "message", channel, seq: row.seq, data: JSON.parse(row.data) }),
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
    this.#state.storage.sql.exec(
      "DELETE FROM ring WHERE channel = ? AND seq <= ?",
      body.channel,
      bounds.seqAtOrBelow,
    );
    this.#state.storage.sql.exec(
      "DELETE FROM ring WHERE channel = ? AND at < ?",
      body.channel,
      bounds.agedOutBefore,
    );

    // The registry is the runtime: enumerate this channel's live sockets and fan out
    // over them with the pure core. workerd evicts a closed socket from the tag set,
    // so the list is current even after the DO woke from nothing. `maxBufferedBytes`
    // bounds each socket's outbound queue: workerd exposes `bufferedAmount` but has no
    // drain event, so backpressure is a poll at send time.
    const { delivered, failed } = fanout(
      this.#state.getWebSockets(body.channel),
      { type: "message", channel: body.channel, seq, data: body.message },
      { maxBufferedBytes: MAX_BUFFERED_BYTES },
    );

    // Close every socket the fan-out could not write to — a slow consumer over the
    // buffer bound (never buffered without limit) or one whose send threw. `1013`
    // ("try again later") tells the client to reconnect; with the replay ring it then
    // resumes via `?since=` and misses nothing within the retained window (drop-to-
    // resync, `@lesto/realtime`'s policy for a socket transport). Closing an already
    // dead socket is a harmless no-op.
    for (const socket of failed) {
      // Closing an already-errored socket can throw on some runtimes; swallow it so one
      // bad close never aborts reaping the rest or 500s a fully-delivered publish.
      try {
        socket.close(1013, "slow-consumer");
      } catch {
        // already gone
      }
    }

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
