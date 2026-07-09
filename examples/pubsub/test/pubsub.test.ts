/**
 * The fan-out app driven in-process, over fake Bun sockets — no real server. This
 * proves the `src/app.ts` wiring (route matching, the authz guard, upgrade handoff,
 * open/close lifecycle, publish validation) around `@lesto/pubsub`'s `fanout` +
 * `FanoutRegistry` + `verifyChannelToken`; the real socket path is `serve.smoke.test.ts`.
 *
 * Sockets are opened by calling `app.websocket.open(...)` directly, so a subscriber
 * fixture needs no token; the authz guard is exercised through `app.fetch(...)` on
 * both routes (a missing / wrong-mode token is `401`ed; a valid token is admitted).
 */

import { mintChannelToken } from "@lesto/pubsub";
import type { ChannelMode } from "@lesto/pubsub";
import { describe, expect, it } from "vitest";

import { buildFanoutServer } from "../src/app";

const SECRET = "test-signing-secret";

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

/** A short-lived capability token for `(channel, mode)`, signed with the test secret. */
function token(channel: string, mode: ChannelMode): Promise<string> {
  return mintChannelToken({ channel, mode, exp: Date.now() + 60_000 }, SECRET);
}

/** A publish request against the app's `POST /publish` route, carrying `bearer` (if any). */
function publish(channel: string, message: unknown, bearer?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer !== undefined) {
    headers.authorization = `Bearer ${bearer}`;
  }

  return new Request("http://x/publish", {
    method: "POST",
    headers,
    body: JSON.stringify({ channel, message }),
  });
}

/** A fake Bun `Server` whose `upgrade` succeeds — the publish path never calls it. */
const upgradeOk = { upgrade: () => true };

describe("examples/pubsub — buildFanoutServer", () => {
  it("fans a published message out to every open subscriber on the channel", async () => {
    const app = buildFanoutServer({ secret: SECRET });
    const a = fakeSocket("news");
    const b = fakeSocket("news");

    app.websocket.open(a);
    app.websocket.open(b);

    const res = await app.fetch(
      publish("news", { hi: 1 }, await token("news", "publish")),
      upgradeOk,
    );

    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ delivered: 2 });

    expect(a.frames).toEqual([{ type: "message", channel: "news", seq: 1, data: { hi: 1 } }]);
    expect(b.frames).toHaveLength(1);
  });

  it("does not deliver a message to subscribers of another channel", async () => {
    const app = buildFanoutServer({ secret: SECRET });
    const news = fakeSocket("news");

    app.websocket.open(news);

    const res = await app.fetch(
      publish("sports", "goal", await token("sports", "publish")),
      upgradeOk,
    );

    expect(await res?.json()).toEqual({ delivered: 0 });
    expect(news.sent).toHaveLength(0);
  });

  it("stops delivering to a closed subscriber", async () => {
    const app = buildFanoutServer({ secret: SECRET });
    const socket = fakeSocket("news");

    app.websocket.open(socket);
    app.websocket.close(socket);

    const res = await app.fetch(
      publish("news", "after-close", await token("news", "publish")),
      upgradeOk,
    );

    expect(await res?.json()).toEqual({ delivered: 0 });
    expect(socket.sent).toHaveLength(0);
  });

  it("ignores anything a subscriber sends", () => {
    const app = buildFanoutServer({ secret: SECRET });
    const socket = fakeSocket("news");

    app.websocket.open(socket);

    expect(() => app.websocket.message(socket, "noise")).not.toThrow();
    expect(socket.sent).toHaveLength(0);
  });

  it("upgrades a /subscribe request that names a channel and carries a valid token", async () => {
    const app = buildFanoutServer({ secret: SECRET });
    let seeded: { channel: string } | undefined;

    const server = {
      upgrade: (_request: Request, options: { data: { channel: string } }) => {
        seeded = options.data;

        return true;
      },
    };

    const subscribeToken = await token("news", "subscribe");
    const res = await app.fetch(
      new Request(`http://x/subscribe?channel=news&token=${encodeURIComponent(subscribeToken)}`),
      server,
    );

    expect(res).toBeUndefined();
    expect(seeded).toEqual({ channel: "news" });
  });

  it("rejects a /subscribe with no channel (400) — before token check or upgrade", async () => {
    const app = buildFanoutServer({ secret: SECRET });

    const res = await app.fetch(new Request("http://x/subscribe"), {
      upgrade: () => {
        throw new Error("upgrade must not be attempted for a channel-less subscribe");
      },
    });

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
  });

  it("rejects a /subscribe with no token (401) — before upgrade", async () => {
    const app = buildFanoutServer({ secret: SECRET });

    const res = await app.fetch(new Request("http://x/subscribe?channel=news"), {
      upgrade: () => {
        throw new Error("upgrade must not be attempted for an unauthorized subscribe");
      },
    });

    expect((res as Response).status).toBe(401);
  });

  it("rejects a /subscribe with a publish-mode token (401 wrong-mode)", async () => {
    const app = buildFanoutServer({ secret: SECRET });
    const wrongMode = await token("news", "publish");

    const res = await app.fetch(
      new Request(`http://x/subscribe?channel=news&token=${encodeURIComponent(wrongMode)}`),
      {
        upgrade: () => {
          throw new Error("upgrade must not be attempted for a wrong-mode token");
        },
      },
    );

    expect((res as Response).status).toBe(401);
    expect(await (res as Response).text()).toContain("wrong-mode");
  });

  it("answers a non-upgradable /subscribe with 426 (after the token passes)", async () => {
    const app = buildFanoutServer({ secret: SECRET });
    const subscribeToken = await token("news", "subscribe");

    const res = await app.fetch(
      new Request(`http://x/subscribe?channel=news&token=${encodeURIComponent(subscribeToken)}`),
      { upgrade: () => false },
    );

    expect((res as Response).status).toBe(426);
  });

  it("rejects a publish with no token (401)", async () => {
    const app = buildFanoutServer({ secret: SECRET });

    const res = await app.fetch(publish("news", "x"), upgradeOk);

    expect((res as Response).status).toBe(401);
  });

  it("rejects a publish carrying a subscribe-mode token (401 wrong-mode)", async () => {
    const app = buildFanoutServer({ secret: SECRET });

    const res = await app.fetch(publish("news", "x", await token("news", "subscribe")), upgradeOk);

    expect((res as Response).status).toBe(401);
    expect(await (res as Response).text()).toContain("wrong-mode");
  });

  it("rejects a publish token scoped to a different channel (401 wrong-channel)", async () => {
    const app = buildFanoutServer({ secret: SECRET });

    const res = await app.fetch(publish("news", "x", await token("sports", "publish")), upgradeOk);

    expect((res as Response).status).toBe(401);
    expect(await (res as Response).text()).toContain("wrong-channel");
  });

  it("rejects a malformed /publish body with 400 — before token check", async () => {
    const app = buildFanoutServer({ secret: SECRET });

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
    const app = buildFanoutServer({ secret: SECRET });

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

  it("answers an unknown route with 404", async () => {
    const app = buildFanoutServer({ secret: SECRET });

    const res = await app.fetch(new Request("http://x/nope"), upgradeOk);

    expect((res as Response).status).toBe(404);
  });
});
