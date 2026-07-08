/**
 * The pubsub fan-out app as substrate-neutral Bun handlers, shared by `serve.ts`
 * (a live server) and `test/pubsub.test.ts` (in-process). `@lesto/pubsub`'s
 * {@link FanoutRoom} is the whole brain; this file is only the HTTP + WebSocket
 * plumbing around it:
 *
 *   - `GET  /subscribe?channel=<name>` upgrades to a WebSocket and, on open,
 *     subscribes the socket to the channel; every publish to that channel
 *     arrives as one framed message.
 *   - `POST /publish  { "channel": <name>, "message": <any> }` fans the message
 *     out to that channel's subscribers and returns `{ delivered }`.
 *
 * On Node the single process IS the coordination point, so one `FanoutRoom`
 * serves every connection. On Cloudflare that role belongs to a Durable Object
 * (`room.ts`), because edge isolates share no memory — but the DO runs the SAME
 * `FanoutRoom`, so the fan-out semantics are identical across the two substrates.
 *
 * Bun's `Server`/`ServerWebSocket` have no `@types/bun` in this tree, so the slim
 * slices this app uses are typed locally (the `packages/cli/src/bin.ts` approach).
 */

import { FanoutRoom, parsePublishBody } from "@lesto/pubsub";

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
  fetch(request: Request, server: BunServer): Response | Promise<Response> | undefined;
  websocket: {
    open(ws: BunSocket): void;
    message(ws: BunSocket, message: string): void;
    close(ws: BunSocket): void;
  };
}

/** Answer `POST /publish` — validate the body, fan it out, report how many it reached. */
async function handlePublish(room: FanoutRoom, request: Request): Promise<Response> {
  const body = parsePublishBody(await request.json());

  if (body === undefined) {
    return new Response('expected { "channel": string, "message": <any> }', { status: 400 });
  }

  const delivered = await room.publish(body.channel, body.message);

  return Response.json({ delivered });
}

/** Build the fan-out app over one {@link FanoutRoom}. Handlers close over the room, not `this`, so they detach cleanly for `Bun.serve`. */
export function buildFanoutServer(): FanoutServer {
  const room = new FanoutRoom();

  return {
    room,

    fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/subscribe") {
        const channel = url.searchParams.get("channel");

        if (channel === null || channel.length === 0) {
          return new Response("missing ?channel", { status: 400 });
        }

        // Bun finishes the handshake and then fires `websocket.open`; returning
        // undefined hands the connection to the socket handlers below.
        if (server.upgrade(request, { data: { channel } })) {
          return undefined;
        }

        return new Response("expected a websocket upgrade", { status: 426 });
      }

      if (url.pathname === "/publish" && request.method === "POST") {
        return handlePublish(room, request);
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
