/**
 * The fan-out app driven in-process, over fake Bun sockets — no real server. This
 * proves the `src/app.ts` wiring (route matching, upgrade handoff, open/close
 * lifecycle, publish validation) around `@lesto/pubsub`'s `FanoutRoom`; the real
 * socket path is proven by `serve.smoke.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { buildFanoutServer } from "../src/app";

interface FrameData {
  type: string;
  channel: string;
  seq: number;
  data: unknown;
}

/** A fake Bun `ServerWebSocket`: records frames, carries the upgrade's `data`. */
function fakeSocket(channel: string) {
  return {
    data: { channel } as { channel: string; off?: () => void },
    sent: [] as string[],
    send(raw: string): void {
      this.sent.push(raw);
    },
    get frames(): FrameData[] {
      return this.sent.map((raw) => JSON.parse(raw) as FrameData);
    },
  };
}

/** A publish request against the app's `POST /publish` route. */
function publish(channel: string, message: unknown): Request {
  return new Request("http://x/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, message }),
  });
}

/** A fake Bun `Server` whose `upgrade` succeeds — the publish path never calls it. */
const upgradeOk = { upgrade: () => true };

describe("examples/pubsub — buildFanoutServer", () => {
  it("fans a published message out to every open subscriber on the channel", async () => {
    const app = buildFanoutServer();
    const a = fakeSocket("news");
    const b = fakeSocket("news");

    app.websocket.open(a);
    app.websocket.open(b);

    const res = await app.fetch(publish("news", { hi: 1 }), upgradeOk);

    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ delivered: 2 });

    expect(a.frames).toEqual([{ type: "message", channel: "news", seq: 1, data: { hi: 1 } }]);
    expect(b.frames).toHaveLength(1);
  });

  it("does not deliver a message to subscribers of another channel", async () => {
    const app = buildFanoutServer();
    const news = fakeSocket("news");

    app.websocket.open(news);

    const res = await app.fetch(publish("sports", "goal"), upgradeOk);

    expect(await res?.json()).toEqual({ delivered: 0 });
    expect(news.sent).toHaveLength(0);
  });

  it("stops delivering to a closed subscriber", async () => {
    const app = buildFanoutServer();
    const socket = fakeSocket("news");

    app.websocket.open(socket);
    app.websocket.close(socket);

    const res = await app.fetch(publish("news", "after-close"), upgradeOk);

    expect(await res?.json()).toEqual({ delivered: 0 });
    expect(socket.sent).toHaveLength(0);
  });

  it("ignores anything a subscriber sends", () => {
    const app = buildFanoutServer();
    const socket = fakeSocket("news");

    app.websocket.open(socket);

    expect(() => app.websocket.message(socket, "noise")).not.toThrow();
    expect(socket.sent).toHaveLength(0);
  });

  it("upgrades a /subscribe request that names a channel", () => {
    const app = buildFanoutServer();
    let seeded: { channel: string } | undefined;

    const server = {
      upgrade: (_request: Request, options: { data: { channel: string } }) => {
        seeded = options.data;

        return true;
      },
    };

    const res = app.fetch(new Request("http://x/subscribe?channel=news"), server);

    expect(res).toBeUndefined();
    expect(seeded).toEqual({ channel: "news" });
  });

  it("rejects a /subscribe with no channel (400) — before any upgrade", () => {
    const app = buildFanoutServer();

    const res = app.fetch(new Request("http://x/subscribe"), {
      upgrade: () => {
        throw new Error("upgrade must not be attempted for a channel-less subscribe");
      },
    });

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
  });

  it("answers a non-upgradable /subscribe with 426", () => {
    const app = buildFanoutServer();

    const res = app.fetch(new Request("http://x/subscribe?channel=news"), { upgrade: () => false });

    expect((res as Response).status).toBe(426);
  });

  it("rejects a malformed /publish body with 400", async () => {
    const app = buildFanoutServer();

    const res = await app.fetch(
      new Request("http://x/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nope: true }),
      }),
      upgradeOk,
    );

    expect((res as Response).status).toBe(400);
  });

  it("rejects a non-JSON /publish body with 400 (not a 500)", async () => {
    const app = buildFanoutServer();

    const res = await app.fetch(
      new Request("http://x/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json{{",
      }),
      upgradeOk,
    );

    expect((res as Response).status).toBe(400);
  });

  it("answers an unknown route with 404", () => {
    const app = buildFanoutServer();

    const res = app.fetch(new Request("http://x/nope"), upgradeOk);

    expect((res as Response).status).toBe(404);
  });
});
