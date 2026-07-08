/**
 * The pubsub fan-out app as substrate-neutral Bun handlers, shared by `serve.ts`
 * (a live server) and `test/pubsub.test.ts` (in-process). `@lesto/pubsub`'s
 * {@link FanoutRoom} is the fan-out brain; {@link verifyChannelToken} is the authz
 * brain; this file is only the HTTP + WebSocket plumbing around them:
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
 * On Node the single process IS the coordination point, so one `FanoutRoom` serves
 * every connection. On Cloudflare that role belongs to a Durable Object (`room.ts`),
 * because edge isolates share no memory — but the DO runs the SAME `FanoutRoom` and
 * the SAME `verifyChannelToken`, so the semantics are identical across substrates.
 *
 * Bun's `Server`/`ServerWebSocket` have no `@types/bun` in this tree, so the slim
 * slices this app uses are typed locally (the `packages/cli/src/bin.ts` approach).
 */

import { FanoutRoom, parsePublishBody, verifyChannelToken } from "@lesto/pubsub";
import type { ChannelMode } from "@lesto/pubsub";

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
}

/** The slice of Bun's `Server` this app's fetch handler uses. */
interface BunServer {
  upgrade(request: Request, options: { data: SocketData }): boolean;
}

/** What {@link buildFanoutServer} returns — the shape `Bun.serve` consumes, plus the room. */
export interface FanoutServer {
  room: FanoutRoom;
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

/** Build the fan-out app over one {@link FanoutRoom}, verifying tokens signed with `secret`. */
export function buildFanoutServer(opts: { secret: string }): FanoutServer {
  const room = new FanoutRoom();
  const { secret } = opts;

  return {
    room,

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

        const delivered = await room.publish(body.channel, body.message);

        return Response.json({ delivered });
      }

      return new Response("not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        ws.data.off = room.add({ send: (data) => ws.send(data) }, ws.data.channel);
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
