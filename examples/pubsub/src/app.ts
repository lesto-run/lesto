/**
 * The pubsub fan-out app as substrate-neutral Bun handlers, shared by `serve.ts`
 * (a live server) and `test/pubsub.test.ts` (in-process). `@lesto/pubsub`'s
 * {@link fanout} + {@link FanoutRegistry} are the fan-out brain; {@link verifyChannelToken}
 * is the authz brain; this file is only the HTTP + WebSocket plumbing around them:
 *
 *   - `GET  /subscribe?channel=<name>&token=<t>` verifies a `subscribe`-mode token
 *     scoped to `<name>`, then upgrades to a WebSocket subscribed to the channel;
 *     every publish to that channel arrives as one framed message.
 *   - `POST /publish  { "channel": <name>, "message": <any> }` (with a `publish`-mode
 *     token in `Authorization: Bearer` or `?token=`) fans the message out to that
 *     channel's subscribers and returns `{ delivered }`.
 *
 * Authz is verified HERE, before any upgrade or publish, so the Node path is
 * authenticated exactly like the edge Worker — and the guard gets real behavioral
 * coverage from `serve.smoke.test.ts`. A browser cannot set headers on a WebSocket
 * upgrade, so the subscribe token rides the query string (a short-lived, single-
 * `(channel, mode)` capability, not a master credential — see `@lesto/pubsub`'s
 * `channel-token.ts`).
 *
 * On Node the single process IS the coordination point, so one `FanoutRegistry` (a
 * plain in-memory `channel → sockets` map) plus an in-process `seq` serves every
 * connection. On Cloudflare that role belongs to a hibernatable Durable Object
 * (`room.ts`), whose registry is the workerd runtime (`state.getWebSockets`) and
 * whose `seq` is durable — but both substrates share the SAME pure {@link fanout}
 * send policy and the SAME {@link verifyChannelToken}, so the semantics are identical.
 *
 * Bun's `Server`/`ServerWebSocket` have no `@types/bun` in this tree, so the slim
 * slices this app uses are typed locally (the `packages/cli/src/bin.ts` approach).
 */

import { FanoutRegistry, fanout, parsePublishBody, verifyChannelToken } from "@lesto/pubsub";
import type { ChannelMode, FanoutSocket } from "@lesto/pubsub";

/**
 * The most bytes a subscriber may have queued-but-unsent before it is treated as a slow
 * consumer and closed (backpressure). A healthy client drains far below this; a socket
 * that lets 1 MiB pile up is stuck. Bun's `ServerWebSocket` reports the queue via
 * `getBufferedAmount()`; where a transport reports nothing, `fanout` leaves the bound
 * unenforced. Demo-scale; a production bus would tune it.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** Per-connection data Bun carries from the upgrade into the socket handlers. */
interface SocketData {
  /** The channel this socket subscribed to (from `?channel=`). */
  channel: string;

  /** The close thunk, set on open so `close` can unsubscribe. */
  off?: () => void;
}

/** The slice of Bun's `ServerWebSocket` this app uses. */
interface BunSocket {
  data: SocketData;
  send(data: string): void;
  /** Bytes queued but unsent — Bun's backpressure signal (workerd exposes it as a property). */
  getBufferedAmount(): number;
  /** Close the socket; `1013` ("try again later") asks the client to reconnect. */
  close(code?: number, reason?: string): void;
}

/**
 * A subscriber as the fan-out core sees it: the pure {@link FanoutSocket} send/bound
 * seam, plus a `close` so a slow or dead consumer can be reaped (drop-to-resync). The
 * `bufferedAmount` getter reads Bun's `getBufferedAmount()` so the backpressure bound
 * measures the real outbound queue.
 */
interface SubscriberSocket extends FanoutSocket {
  close(): void;
}

/** The slice of Bun's `Server` this app's fetch handler uses. */
interface BunServer {
  upgrade(request: Request, options: { data: SocketData }): boolean;
}

/** What {@link buildFanoutServer} returns — the shape `Bun.serve` consumes. */
export interface FanoutServer {
  fetch(request: Request, server: BunServer): Promise<Response | undefined>;
  websocket: {
    open(ws: BunSocket): void;
    message(ws: BunSocket, message: string): void;
    close(ws: BunSocket): void;
  };
}

/**
 * Pull a capability token off a request: the `Authorization: Bearer <t>` header
 * first (what an HTTP publisher uses), else the `?token=` query param (what a
 * browser WebSocket upgrade must use — it cannot set headers). `""` when absent,
 * which {@link verifyChannelToken} rejects as `malformed`.
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
  secret: string,
): Promise<Response | undefined> {
  const result = await verifyChannelToken(readToken(request, url), { channel, mode }, secret);

  if (!result.ok) {
    return new Response(`unauthorized: ${result.reason}`, { status: 401 });
  }

  return undefined;
}

/** Build the fan-out app over one {@link FanoutRegistry}, verifying tokens signed with `secret`. */
export function buildFanoutServer(opts: { secret: string }): FanoutServer {
  const registry = new FanoutRegistry<SubscriberSocket>();
  const { secret } = opts;

  // The per-message sequence lives in this single process (the DO keeps a durable
  // one — see room.ts). Monotonic across every publish on every channel.
  let seq = 0;

  return {
    async fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/subscribe") {
        const channel = url.searchParams.get("channel");

        if (channel === null || channel.length === 0) {
          return new Response("missing ?channel", { status: 400 });
        }

        const denied = await guard(request, url, channel, "subscribe", secret);
        if (denied !== undefined) {
          return denied;
        }

        // Bun finishes the handshake and then fires `websocket.open`; returning
        // undefined hands the connection to the socket handlers below.
        if (server.upgrade(request, { data: { channel } })) {
          return undefined;
        }

        return new Response("expected a websocket upgrade", { status: 426 });
      }

      if (url.pathname === "/publish" && request.method === "POST") {
        // A non-JSON body rejects `.json()`; treat it as malformed → 400, not a 500.
        const body = parsePublishBody(await request.json().catch(() => undefined));

        if (body === undefined) {
          return new Response('expected { "channel": string, "message": <any> }', { status: 400 });
        }

        const denied = await guard(request, url, body.channel, "publish", secret);
        if (denied !== undefined) {
          return denied;
        }

        seq += 1;
        const { delivered, failed } = fanout(
          registry.socketsFor(body.channel),
          { type: "message", channel: body.channel, seq, data: body.message },
          { maxBufferedBytes: MAX_BUFFERED_BYTES },
        );

        // Reap every socket the fan-out could not write to — a slow consumer over the
        // buffer bound, or one whose send threw. Close it (the client reconnects; the
        // Node substrate has no `?since=` resume, so it resubscribes fresh) and drop it
        // so the next publish skips it. Closing a dead socket is a harmless no-op.
        for (const socket of failed) {
          socket.close();
          registry.drop(body.channel, socket);
        }

        return Response.json({ delivered });
      }

      return new Response("not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        // Adapt Bun's socket to the fan-out seam: `bufferedAmount` reads Bun's
        // `getBufferedAmount()` (the backpressure signal); `close` sends `1013` so a
        // reaped slow consumer reconnects.
        ws.data.off = registry.add(ws.data.channel, {
          send: (data) => ws.send(data),
          get bufferedAmount() {
            return ws.getBufferedAmount();
          },
          close: () => ws.close(1013, "slow-consumer"),
        });
      },

      message() {
        // Subscribers never send; ignore anything they do.
      },

      close(ws) {
        ws.data.off?.();
      },
    },
  };
}
