import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb } from "@keel/db";
import type { Db, SqlDatabase } from "@keel/db";
import { Migrator } from "@keel/migrate";
import { installSchema, Queue } from "@keel/queue";
import { Mailer } from "@keel/mail";

import {
  createMailingLists,
  findSubscriberByEmail,
  findSubscriberById,
  insertList,
  MailingListError,
  mailingListsMigration,
  pendingBroadcastDeliveries,
} from "../src/index";

import type { MailingLists } from "../src/index";
import type { SqlDatabase as QueueDatabase } from "@keel/queue";
import type { RenderedEmail } from "@keel/mail";

// ---------------------------------------------------------------------------
// Test rig
//
// One in-memory SQLite per test, adapted to @keel/db's `SqlDatabase` shape.
// The terminals are async (ADR 0006): the synchronous better-sqlite3 engine is
// wrapped so each terminal resolves a Promise (zero latency); prepare() stays
// sync, and transaction() pins the single in-memory connection.
//
// Both @keel/db and @keel/queue now speak the same positional, async seam, so a
// single adapter handle serves both — matching production and the queue's own test.
// ---------------------------------------------------------------------------

function adapt(raw: Database.Database): SqlDatabase {
  const adapted: SqlDatabase = {
    exec: async (statement) => {
      raw.exec(statement);
    },
    prepare: (statement) => {
      const stmt = raw.prepare(statement);

      return {
        run: async (params: unknown[] = []) => stmt.run(...(params as never[])),
        get: async (params: unknown[] = []) => stmt.get(...(params as never[])),
        all: async (params: unknown[] = []) => stmt.all(...(params as never[])),
      };
    },
    transaction: async (fn) => {
      raw.exec("BEGIN");

      try {
        const out = await fn(adapted);
        raw.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* preserve the original error */
        }

        throw error;
      }
    },
  };

  return adapted;
}

let raw: Database.Database;
let sql: SqlDatabase;
let db: Db;
let queue: Queue;
let mailer: Mailer;
let lists: MailingLists;
let sent: RenderedEmail[];

const transport = {
  send: async (email: RenderedEmail): Promise<void> => {
    sent.push(email);
  },
};

// Drain every queued delivery so the fake transport observes them.
async function deliverAll(): Promise<void> {
  while ((await queue.runOnce()) !== null) {
    // keep draining until the queue is idle
  }
}

// A confirmed, subscribed recipient — the common precondition.
async function subscribeAndConfirm(listId: number, email: string): Promise<void> {
  const sub = await lists.subscribe(listId, email);
  await lists.confirm(sub.confirmToken!);
}

beforeEach(async () => {
  raw = new Database(":memory:");
  sql = adapt(raw);
  db = createDb(sql);

  // The package ships its own migration now — no hand-rolled CREATE TABLE
  // in the test fixture.
  await new Migrator(sql, [mailingListsMigration]).migrate();

  // The queue rides the SAME async adapter as @keel/db — one connection, one seam.
  await installSchema(sql as unknown as QueueDatabase);

  queue = new Queue({ db: sql as unknown as QueueDatabase });
  mailer = new Mailer({ queue, transport });

  // The broadcast template spreads `params.headers` into the email it returns —
  // the documented contract that carries the List-Unsubscribe headers through.
  mailer.define<{ to: string; issue: number; headers?: Record<string, string> }>(
    "digest",
    ({ to, issue, headers }) => ({
      to,
      subject: `Issue #${issue}`,
      html: `<p>Issue ${issue}</p>`,
      ...(headers === undefined ? {} : { headers }),
    }),
  );

  // The confirmation template.
  mailer.define<{ to: string; confirmUrl: string }>("confirm", ({ to, confirmUrl }) => ({
    to,
    subject: "Confirm your subscription",
    html: `<a href="${confirmUrl}">Confirm</a>`,
  }));

  sent = [];

  // A deterministic token sequence so assertions are exact.
  let n = 0;
  lists = createMailingLists({ db, mailer, token: () => `token-${++n}` });
});

afterEach(() => {
  raw.close();
});

describe("MailingLists — double opt-in (item 3)", () => {
  it("subscribe creates a pending subscriber carrying fresh confirm + unsubscribe tokens", async () => {
    const list = await insertList(db, { name: "Weekly" });

    const subscriber = await lists.subscribe(list.id, "ada@example.com");

    expect(subscriber.status).toBe("pending");
    expect(subscriber.email).toBe("ada@example.com");
    expect(subscriber.listId).toBe(list.id);
    expect(subscriber.confirmToken).toBe("token-1");
    expect(subscriber.unsubscribeToken).toBe("token-2");
  });

  it("subscribe rejects a malformed email with a coded error and writes no row", async () => {
    expect.assertions(3);

    const list = await insertList(db, { name: "Weekly" });

    try {
      await lists.subscribe(list.id, "not-an-email");
    } catch (error) {
      expect(error).toBeInstanceOf(MailingListError);
      expect((error as MailingListError).code).toBe("MAILING_LIST_INVALID_EMAIL");
    }

    expect(await findSubscriberByEmail(db, list.id, "not-an-email")).toBeUndefined();
  });

  it("accepts a normal dotted-domain address", async () => {
    const list = await insertList(db, { name: "Weekly" });

    const subscriber = await lists.subscribe(list.id, "ada.lovelace@sub.example.co.uk");

    expect(subscriber.status).toBe("pending");
  });

  it("a configured confirmationMailer enqueues a confirmation email on subscribe", async () => {
    const list = await insertList(db, { name: "Weekly" });

    const withConfirm = createMailingLists({
      db,
      mailer,
      token: (() => {
        let n = 0;

        return () => `c-${++n}`;
      })(),
      confirmationMailer: {
        name: "confirm",
        confirmUrl: (token) => `https://app.example.com/confirm/${token}`,
      },
    });

    await withConfirm.subscribe(list.id, "ada@example.com");
    await deliverAll();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ada@example.com");
    expect(sent[0]!.subject).toBe("Confirm your subscription");
    // The confirm URL carries the confirm token (c-1), not the unsubscribe token.
    expect(sent[0]!.html).toContain("https://app.example.com/confirm/c-1");
  });

  it("subscribe without a confirmationMailer enqueues nothing", async () => {
    const list = await insertList(db, { name: "Weekly" });

    await lists.subscribe(list.id, "ada@example.com");
    await deliverAll();

    expect(sent).toHaveLength(0);
  });

  it("a duplicate subscribe is an UPSERT — one row, reset to pending with new tokens", async () => {
    const list = await insertList(db, { name: "Weekly" });

    const first = await lists.subscribe(list.id, "ada@example.com");
    await lists.confirm(first.confirmToken!);
    expect((await findSubscriberById(db, first.id))?.status).toBe("subscribed");

    // Re-subscribing the same address resets the SAME row to pending.
    const second = await lists.subscribe(list.id, "ada@example.com");

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("pending");
    expect(second.confirmToken).not.toBe(first.confirmToken);
    expect(second.unsubscribeToken).not.toBe(first.unsubscribeToken);

    // Exactly one row for the address.
    const onlyRow = await findSubscriberByEmail(db, list.id, "ada@example.com");
    expect(onlyRow?.id).toBe(first.id);
  });

  it("confirm flips a pending subscriber to subscribed and ROTATES the confirm token", async () => {
    const list = await insertList(db, { name: "Weekly" });
    const subscriber = await lists.subscribe(list.id, "ada@example.com");

    const confirmed = await lists.confirm(subscriber.confirmToken!);

    expect(confirmed.status).toBe("subscribed");
    expect(confirmed.confirmToken).toBeNull();

    const stored = await findSubscriberById(db, subscriber.id);
    expect(stored?.status).toBe("subscribed");
    expect(stored?.confirmToken).toBeNull();

    // The spent confirm link no longer matches a pending row — replay refused.
    await expect(lists.confirm(subscriber.confirmToken!)).rejects.toMatchObject({
      code: "MAILING_LIST_INVALID_TOKEN",
    });
  });

  it("confirm throws a coded error for an unknown token", async () => {
    expect.assertions(2);

    try {
      await lists.confirm("nope");
    } catch (error) {
      expect(error).toBeInstanceOf(MailingListError);
      expect((error as MailingListError).code).toBe("MAILING_LIST_INVALID_TOKEN");
    }
  });

  it("unsubscribe flips the matching subscriber to unsubscribed via the unsubscribe token", async () => {
    const list = await insertList(db, { name: "Weekly" });
    const subscriber = await lists.subscribe(list.id, "ada@example.com");
    await lists.confirm(subscriber.confirmToken!);

    const removed = await lists.unsubscribe(subscriber.unsubscribeToken!);

    expect(removed.status).toBe("unsubscribed");
    expect((await findSubscriberById(db, subscriber.id))?.status).toBe("unsubscribed");
  });

  it("unsubscribe throws a coded error for an unknown token", async () => {
    expect.assertions(2);

    try {
      await lists.unsubscribe("nope");
    } catch (error) {
      expect(error).toBeInstanceOf(MailingListError);
      expect((error as MailingListError).code).toBe("MAILING_LIST_INVALID_TOKEN");
    }
  });

  it("defaults to a random hex token generator when none is injected", async () => {
    const defaults = createMailingLists({ db, mailer });
    const list = await insertList(db, { name: "Weekly" });

    const subscriber = await defaults.subscribe(list.id, "ada@example.com");

    // 16 random bytes → 32 hex characters, and the two tokens differ.
    expect(subscriber.confirmToken).toMatch(/^[0-9a-f]{32}$/);
    expect(subscriber.unsubscribeToken).toMatch(/^[0-9a-f]{32}$/);
    expect(subscriber.confirmToken).not.toBe(subscriber.unsubscribeToken);
  });

  it("insertList accepts a null name (the column is nullable)", async () => {
    const list = await insertList(db, { name: null });

    expect(list.name).toBeNull();
  });

  it("the migration's down drops all four tables", async () => {
    const migrator = new Migrator(sql, [mailingListsMigration]);

    expect(await migrator.rollback()).toBe(mailingListsMigration.version);
    expect(() => raw.prepare("SELECT * FROM lists").all()).toThrow();
    expect(() => raw.prepare("SELECT * FROM subscribers").all()).toThrow();
    expect(() => raw.prepare("SELECT * FROM broadcasts").all()).toThrow();
    expect(() => raw.prepare("SELECT * FROM broadcast_deliveries").all()).toThrow();
  });
});

describe("MailingLists — resumable broadcasts + deliverability (item 4)", () => {
  it("broadcast enqueues exactly one delivery per SUBSCRIBED recipient and returns { broadcastId, enqueued }", async () => {
    const list = await insertList(db, { name: "Weekly" });

    await subscribeAndConfirm(list.id, "ada@example.com");
    await subscribeAndConfirm(list.id, "grace@example.com");

    // A still-pending subscriber — must be skipped.
    await lists.subscribe(list.id, "pending@example.com");

    // An unsubscribed subscriber — must be skipped.
    const gone = await lists.subscribe(list.id, "gone@example.com");
    await lists.confirm(gone.confirmToken!);
    await lists.unsubscribe(gone.unsubscribeToken!);

    const result = await lists.broadcast(list.id, "digest", { issue: 42 });

    expect(result.enqueued).toBe(2);
    expect(typeof result.broadcastId).toBe("number");

    await deliverAll();

    const recipients = sent.map((email) => email.to).toSorted();
    expect(recipients).toEqual(["ada@example.com", "grace@example.com"]);
    expect(sent.every((email) => email.subject === "Issue #42")).toBe(true);
  });

  it("a broadcast to an empty list enqueues nothing and is immediately complete", async () => {
    const list = await insertList(db, { name: "Empty" });

    const result = await lists.broadcast(list.id, "digest", { issue: 1 });

    expect(result.enqueued).toBe(0);
    expect(await pendingBroadcastDeliveries(db, result.broadcastId)).toHaveLength(0);
  });

  it("sets List-Unsubscribe / List-Unsubscribe-Post headers on every broadcast email when unsubscribeUrl is configured", async () => {
    const list = await insertList(db, { name: "Weekly" });

    let n = 0;
    const withUnsub = createMailingLists({
      db,
      mailer,
      token: () => `t-${++n}`,
      unsubscribeUrl: (token) => `https://app.example.com/unsubscribe/${token}`,
    });

    const sub = await withUnsub.subscribe(list.id, "ada@example.com");
    await withUnsub.confirm(sub.confirmToken!);

    await withUnsub.broadcast(list.id, "digest", { issue: 7 });
    await deliverAll();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers?.["List-Unsubscribe"]).toBe(
      `<https://app.example.com/unsubscribe/${sub.unsubscribeToken}>`,
    );
    expect(sent[0]!.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("omits List-Unsubscribe headers when no unsubscribeUrl is configured", async () => {
    const list = await insertList(db, { name: "Weekly" });
    await subscribeAndConfirm(list.id, "ada@example.com");

    await lists.broadcast(list.id, "digest", { issue: 9 });
    await deliverAll();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers).toBeUndefined();
  });

  it("kill-and-rerun mid-fan-out delivers each recipient exactly once", async () => {
    const list = await insertList(db, { name: "Weekly" });
    await subscribeAndConfirm(list.id, "ada@example.com");
    await subscribeAndConfirm(list.id, "grace@example.com");
    await subscribeAndConfirm(list.id, "linus@example.com");

    // A mailer that "crashes" after enqueuing the first recipient — simulating a
    // process death mid-fan-out. The real mailer's `send` is wrapped here.
    const realSend = mailer.send.bind(mailer);
    let calls = 0;
    mailer.send = (async (name: string, params: never, options?: never) => {
      calls += 1;

      if (calls === 2) throw new Error("boom: process died mid-fan-out");

      return realSend(name, params, options);
    }) as typeof mailer.send;

    let broadcastId: number;
    try {
      await lists.broadcast(list.id, "digest", { issue: 11 });
      throw new Error("expected the broadcast to crash");
    } catch (error) {
      expect((error as Error).message).toContain("boom");
    }

    // Recover the in-flight broadcast id from the ledger: it is the one with
    // pending deliveries still on the books.
    const rows = (await db.raw(
      "SELECT DISTINCT broadcast_id FROM broadcast_deliveries WHERE status = 'pending'",
    )) as Array<{ broadcast_id: number }>;
    expect(rows).toHaveLength(1);
    broadcastId = Number(rows[0]!.broadcast_id);

    // Exactly one recipient was enqueued before the crash.
    expect(await pendingBroadcastDeliveries(db, broadcastId)).toHaveLength(2);

    // Restore the mailer and resume — only the still-pending rows re-enqueue.
    mailer.send = realSend;
    const resumed = await lists.resumeBroadcast(broadcastId);
    expect(resumed.enqueued).toBe(2);
    expect(await pendingBroadcastDeliveries(db, broadcastId)).toHaveLength(0);

    await deliverAll();

    // No recipient received twice; all three received exactly once.
    const recipients = sent.map((email) => email.to).toSorted();
    expect(recipients).toEqual(["ada@example.com", "grace@example.com", "linus@example.com"]);
  });

  it("resumeBroadcast on an already-finished broadcast enqueues nothing (idempotent)", async () => {
    const list = await insertList(db, { name: "Weekly" });
    await subscribeAndConfirm(list.id, "ada@example.com");

    const { broadcastId } = await lists.broadcast(list.id, "digest", { issue: 3 });
    await deliverAll();
    sent = [];

    const again = await lists.resumeBroadcast(broadcastId);

    expect(again.enqueued).toBe(0);
    await deliverAll();
    expect(sent).toHaveLength(0);
  });

  it("resumeBroadcast preserves the original params (round-tripped through the ledger)", async () => {
    const list = await insertList(db, { name: "Weekly" });
    await subscribeAndConfirm(list.id, "ada@example.com");

    // Crash the very first send so nothing enqueues, then resume cleanly.
    const realSend = mailer.send.bind(mailer);
    let crashed = false;
    mailer.send = (async (name: string, params: never, options?: never) => {
      if (!crashed) {
        crashed = true;

        throw new Error("boom");
      }

      return realSend(name, params, options);
    }) as typeof mailer.send;

    await expect(lists.broadcast(list.id, "digest", { issue: 99 })).rejects.toThrow("boom");

    const rows = (await db.raw(
      "SELECT DISTINCT broadcast_id FROM broadcast_deliveries WHERE status = 'pending'",
    )) as Array<{ broadcast_id: number }>;
    const broadcastId = Number(rows[0]!.broadcast_id);

    mailer.send = realSend;
    await lists.resumeBroadcast(broadcastId);
    await deliverAll();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("Issue #99");
  });

  it("resumeBroadcast throws a coded error for an unknown broadcast id", async () => {
    expect.assertions(2);

    try {
      await lists.resumeBroadcast(9999);
    } catch (error) {
      expect(error).toBeInstanceOf(MailingListError);
      expect((error as MailingListError).code).toBe("MAILING_LIST_UNKNOWN_BROADCAST");
    }
  });

  it("chunks the delivery-row inserts (a small chunkSize fans out in batches, not one statement)", async () => {
    const list = await insertList(db, { name: "Weekly" });
    await subscribeAndConfirm(list.id, "a@example.com");
    await subscribeAndConfirm(list.id, "b@example.com");
    await subscribeAndConfirm(list.id, "c@example.com");
    await subscribeAndConfirm(list.id, "d@example.com");
    await subscribeAndConfirm(list.id, "e@example.com");

    const chunked = createMailingLists({ db, mailer, chunkSize: 2 });

    const result = await chunked.broadcast(list.id, "digest", { issue: 5 });
    expect(result.enqueued).toBe(5);

    await deliverAll();
    expect(sent).toHaveLength(5);
  });
});
