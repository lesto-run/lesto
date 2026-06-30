import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CHANNEL, PostgresTransport } from "../src/pg-transport";
import type { PgListenClient, PgNotification } from "../src/pg-transport";

/** A fake `pg.Client`: records queries, lets a test emit notifications/errors, drives lifecycle. */
class FakePgClient implements PgListenClient {
  queries: Array<{ sql: string; params?: readonly unknown[] }> = [];

  connected = false;

  ended = false;

  connectImpl: () => Promise<void> = async () => {
    this.connected = true;
  };

  endImpl: () => Promise<void> = async () => {
    this.ended = true;
  };

  #notification: ((message: PgNotification) => void) | undefined;

  #error: ((error: Error) => void) | undefined;

  connect(): Promise<void> {
    return this.connectImpl();
  }

  async query(sql: string, params?: readonly unknown[]): Promise<unknown> {
    this.queries.push(params === undefined ? { sql } : { sql, params });

    return undefined;
  }

  on(event: "notification" | "error", listener: (arg: never) => void): unknown {
    if (event === "notification") this.#notification = listener as (m: PgNotification) => void;
    else this.#error = listener as (e: Error) => void;

    return this;
  }

  end(): Promise<void> {
    return this.endImpl();
  }

  emitNotification(message: PgNotification): void {
    this.#notification?.(message);
  }

  emitError(error: Error): void {
    this.#error?.(error);
  }
}

/** Flush pending microtasks + timers so an async reconnect chain settles. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("PostgresTransport — start + LISTEN", () => {
  it("connects and LISTENs on the default channel, with no generation bump on the first listen", async () => {
    const client = new FakePgClient();
    const bumpGeneration = vi.fn();

    const transport = new PostgresTransport({ createClient: () => client, bumpGeneration });

    await transport.start();

    expect(client.connected).toBe(true);
    expect(client.queries).toEqual([{ sql: `LISTEN ${DEFAULT_CHANNEL}` }]);
    // The first LISTEN missed nothing — no generation bump.
    expect(bumpGeneration).not.toHaveBeenCalled();

    await transport.close();
  });

  it("honors a custom channel", async () => {
    const client = new FakePgClient();
    const transport = new PostgresTransport({ createClient: () => client, channel: "custom" });

    await transport.start();

    expect(client.queries).toEqual([{ sql: "LISTEN custom" }]);
  });
});

describe("PostgresTransport — inbound notifications", () => {
  it("fans a payload topic out to every handler, ignoring a foreign channel or empty payload", async () => {
    const client = new FakePgClient();
    const transport = new PostgresTransport({ createClient: () => client });

    const topics: string[] = [];
    const off = transport.onRemoteMessage((topic) => {
      topics.push(topic);
    });

    await transport.start();

    client.emitNotification({ channel: DEFAULT_CHANNEL, payload: "org:1:posts" });
    client.emitNotification({ channel: "other-channel", payload: "ignored" });
    client.emitNotification({ channel: DEFAULT_CHANNEL, payload: "" });
    client.emitNotification({ channel: DEFAULT_CHANNEL });

    expect(topics).toEqual(["org:1:posts"]);

    // Unsubscribe stops further delivery.
    off();
    client.emitNotification({ channel: DEFAULT_CHANNEL, payload: "after-off" });
    expect(topics).toEqual(["org:1:posts"]);
  });
});

describe("PostgresTransport — publishRemote", () => {
  it("issues a parameterized pg_notify once started", async () => {
    const client = new FakePgClient();
    const transport = new PostgresTransport({ createClient: () => client });

    await transport.start();
    await transport.publishRemote("org:1:posts");

    expect(client.queries).toContainEqual({
      sql: "SELECT pg_notify($1, $2)",
      params: [DEFAULT_CHANNEL, "org:1:posts"],
    });
  });

  it("is a no-op before start (no client yet)", async () => {
    const client = new FakePgClient();
    const transport = new PostgresTransport({ createClient: () => client });

    await transport.publishRemote("org:1:posts");

    expect(client.queries).toEqual([]);
  });

  it("reports a failed publish through onError without throwing (fire-and-forget)", async () => {
    const client = new FakePgClient();
    const onError = vi.fn();
    const transport = new PostgresTransport({ createClient: () => client, onError });

    await transport.start();

    client.query = async () => {
      throw new Error("notify failed");
    };

    await expect(transport.publishRemote("x")).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("PostgresTransport — reconnect", () => {
  it("on a client error, ends the old client and re-LISTENs on a fresh one, bumping the generation", async () => {
    const clients: FakePgClient[] = [];
    const bumpGeneration = vi.fn();
    const onError = vi.fn();

    const transport = new PostgresTransport({
      createClient: () => {
        const client = new FakePgClient();
        clients.push(client);

        return client;
      },
      bumpGeneration,
      onError,
      delay: async () => {}, // no real backoff
    });

    await transport.start();
    expect(clients).toHaveLength(1);

    clients[0]!.emitError(new Error("connection lost"));
    await flush();

    // The old client was ended, a fresh one connected + re-LISTENed, generation bumped.
    expect(onError).toHaveBeenCalledOnce();
    expect(clients[0]!.ended).toBe(true);
    expect(clients).toHaveLength(2);
    expect(clients[1]!.connected).toBe(true);
    expect(clients[1]!.queries).toEqual([{ sql: `LISTEN ${DEFAULT_CHANNEL}` }]);
    expect(bumpGeneration).toHaveBeenCalledOnce();

    await transport.close();
  });

  it("retries when a reconnect attempt itself fails, then succeeds", async () => {
    const clients: FakePgClient[] = [];
    const bumpGeneration = vi.fn();
    const onError = vi.fn();

    const transport = new PostgresTransport({
      createClient: () => {
        const client = new FakePgClient();

        // The FIRST reconnect's client (the 2nd created) fails to connect; the next works.
        if (clients.length === 1) {
          client.connectImpl = async () => {
            throw new Error("db still down");
          };
        }

        clients.push(client);

        return client;
      },
      bumpGeneration,
      onError,
      delay: async () => {},
    });

    await transport.start(); // client 0

    clients[0]!.emitError(new Error("connection lost"));
    await flush();

    // client 1 failed to connect (reported), client 2 connected + LISTENed + bumped.
    expect(clients).toHaveLength(3);
    expect(clients[1]!.connected).toBe(false);
    expect(clients[2]!.connected).toBe(true);
    expect(clients[2]!.queries).toEqual([{ sql: `LISTEN ${DEFAULT_CHANNEL}` }]);
    // The failed connect is reported (plus the original error) — at least twice.
    expect(onError.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Generation bumps once — only the successful re-LISTEN (the failed attempt never reached it).
    expect(bumpGeneration).toHaveBeenCalledOnce();

    await transport.close();
  });

  it("collapses overlapping error events into a single reconnect (no orphaned client, one generation bump)", async () => {
    const clients: FakePgClient[] = [];
    const bumpGeneration = vi.fn();
    let releaseDelay!: () => void;

    const transport = new PostgresTransport({
      createClient: () => {
        const client = new FakePgClient();
        clients.push(client);

        return client;
      },
      bumpGeneration,
      // A backoff held open so a SECOND error lands while the first reconnect is
      // mid-flight (the exact race the guard closes).
      delay: () =>
        new Promise<void>((resolve) => {
          releaseDelay = resolve;
        }),
    });

    await transport.start();
    expect(clients).toHaveLength(1);

    // Two errors in quick succession — the second must NOT launch a second reconnect.
    clients[0]!.emitError(new Error("reset"));
    clients[0]!.emitError(new Error("reset again"));
    await flush();

    // Both errors collapsed into ONE in-flight reconnect session, still awaiting backoff.
    releaseDelay();
    await flush();

    // Exactly one fresh client was minted and the generation bumped exactly once —
    // not two clients (one orphaned) and not a double bump.
    expect(clients).toHaveLength(2);
    expect(clients[1]!.connected).toBe(true);
    expect(bumpGeneration).toHaveBeenCalledOnce();

    await transport.close();
  });

  it("does not resurrect a transport that was closed during the reconnect backoff", async () => {
    const clients: FakePgClient[] = [];
    let releaseDelay!: () => void;

    const transport = new PostgresTransport({
      createClient: () => {
        const client = new FakePgClient();
        clients.push(client);

        return client;
      },
      // A backoff the test holds open, so `close` can race it.
      delay: () =>
        new Promise<void>((resolve) => {
          releaseDelay = resolve;
        }),
    });

    await transport.start();
    expect(clients).toHaveLength(1);

    // Kick the reconnect; it ends client 0 then awaits the (held) backoff.
    clients[0]!.emitError(new Error("connection lost"));
    await flush();

    // Close while the backoff is pending, then release it: the reconnect must bail.
    await transport.close();
    releaseDelay();
    await flush();

    expect(clients).toHaveLength(1); // no second client was ever created
  });

  it("uses the real backoff delay when none is injected", async () => {
    const clients: FakePgClient[] = [];

    const transport = new PostgresTransport({
      createClient: () => {
        const client = new FakePgClient();
        clients.push(client);

        return client;
      },
      // No `delay` injected → the real, unref'd setTimeout backoff runs.
      reconnectMs: 1,
    });

    await transport.start();
    clients[0]!.emitError(new Error("connection lost"));

    // Wait out the real 1ms backoff (plus slack) and let the reconnect settle.
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(clients).toHaveLength(2);
    expect(clients[1]!.connected).toBe(true);

    await transport.close();
  });

  it("a late client error after close does not start a reconnect", async () => {
    const clients: FakePgClient[] = [];
    const transport = new PostgresTransport({
      createClient: () => {
        const client = new FakePgClient();
        clients.push(client);

        return client;
      },
      delay: async () => {},
    });

    await transport.start();
    await transport.close();

    // The closed transport's client emits a late error; the reconnect bails at entry.
    clients[0]!.emitError(new Error("late error"));
    await flush();

    expect(clients).toHaveLength(1);
  });

  it("close before start is a no-op, and close is idempotent", async () => {
    const transport = new PostgresTransport({ createClient: () => new FakePgClient() });

    await expect(transport.close()).resolves.toBeUndefined();

    const client = new FakePgClient();
    const started = new PostgresTransport({ createClient: () => client });
    await started.start();
    await started.close();
    await started.close();

    expect(client.ended).toBe(true);
  });

  it("swallows a failure to end the client on close, reporting it", async () => {
    const client = new FakePgClient();
    const onError = vi.fn();
    client.endImpl = async () => {
      throw new Error("end failed");
    };

    const transport = new PostgresTransport({ createClient: () => client, onError });
    await transport.start();

    await expect(transport.close()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("PostgresTransport — defaults", () => {
  it("works with no bumpGeneration / onError injected (the no-op defaults)", async () => {
    const client = new FakePgClient();
    const transport = new PostgresTransport({ createClient: () => client, delay: async () => {} });

    await transport.start();

    // A notification with no handlers, and an error with default no-op onError, must not throw.
    client.emitNotification({ channel: DEFAULT_CHANNEL, payload: "x" });
    client.emitError(new Error("boom"));
    await flush();

    await transport.close();
  });
});
