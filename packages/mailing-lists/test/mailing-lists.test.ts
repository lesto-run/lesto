import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb } from "@keel/db";
import type { Db, SqlDatabase } from "@keel/db";
import { Migrator } from "@keel/migrate";
import { installSchema, Queue } from "@keel/queue";
import { Mailer } from "@keel/mail";

import {
  createMailingLists,
  findSubscriberById,
  insertList,
  MailingListError,
  mailingListsMigration,
} from "../src/index";

import type { MailingLists } from "../src/index";
import type { SqlDatabase as QueueDatabase } from "@keel/queue";
import type { RenderedEmail } from "@keel/mail";

// ---------------------------------------------------------------------------
// Test rig
//
// One in-memory SQLite per test, adapted to @keel/db's `SqlDatabase` shape.
// @keel/queue binds NAMED params, so it gets the raw Database directly; one
// underlying DB satisfies both consumers through different adapters.
// ---------------------------------------------------------------------------

function adapt(raw: Database.Database): SqlDatabase {
  return {
    exec: (statement) => raw.exec(statement),
    prepare: (statement) => {
      const stmt = raw.prepare(statement);

      return {
        run: (params: unknown[] = []) => stmt.run(...(params as never[])),
        get: (params: unknown[] = []) => stmt.get(...(params as never[])),
        all: (params: unknown[] = []) => stmt.all(...(params as never[])),
      };
    },
  };
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

beforeEach(() => {
  raw = new Database(":memory:");
  sql = adapt(raw);
  db = createDb(sql);

  // The package ships its own migration now — no hand-rolled CREATE TABLE
  // in the test fixture.
  new Migrator(sql, [mailingListsMigration]).migrate();

  // Queue's named-param binding sees the raw Database; @keel/db sees the
  // positional adapter. One underlying file, two shapes.
  installSchema(raw as unknown as QueueDatabase);

  queue = new Queue({ db: raw as unknown as QueueDatabase });
  mailer = new Mailer({ queue, transport });
  mailer.define<{ to: string; issue: number }>("digest", ({ to, issue }) => ({
    to,
    subject: `Issue #${issue}`,
    html: `<p>Issue ${issue}</p>`,
  }));

  sent = [];

  // A deterministic token sequence so assertions are exact.
  let n = 0;
  lists = createMailingLists({ db, mailer, token: () => `token-${++n}` });
});

afterEach(() => {
  raw.close();
});

describe("MailingLists", () => {
  it("subscribe creates a pending subscriber carrying a fresh token", () => {
    const list = insertList(db, { name: "Weekly" });

    const subscriber = lists.subscribe(list.id, "ada@example.com");

    expect(subscriber.status).toBe("pending");
    expect(subscriber.email).toBe("ada@example.com");
    expect(subscriber.listId).toBe(list.id);
    expect(subscriber.token).toBe("token-1");
  });

  it("confirm flips a pending subscriber to subscribed", () => {
    const list = insertList(db, { name: "Weekly" });
    const subscriber = lists.subscribe(list.id, "ada@example.com");

    const confirmed = lists.confirm(subscriber.token!);

    expect(confirmed.status).toBe("subscribed");
    expect(findSubscriberById(db, subscriber.id)?.status).toBe("subscribed");
  });

  it("confirm throws a coded error for an unknown token", () => {
    expect.assertions(2);

    try {
      lists.confirm("nope");
    } catch (error) {
      expect(error).toBeInstanceOf(MailingListError);
      expect((error as MailingListError).code).toBe("MAILING_LIST_INVALID_TOKEN");
    }
  });

  it("unsubscribe flips the matching subscriber to unsubscribed", () => {
    const list = insertList(db, { name: "Weekly" });
    const subscriber = lists.subscribe(list.id, "ada@example.com");
    lists.confirm(subscriber.token!);

    const removed = lists.unsubscribe(subscriber.token!);

    expect(removed.status).toBe("unsubscribed");
    expect(findSubscriberById(db, subscriber.id)?.status).toBe("unsubscribed");
  });

  it("unsubscribe throws a coded error for an unknown token", () => {
    expect.assertions(2);

    try {
      lists.unsubscribe("nope");
    } catch (error) {
      expect(error).toBeInstanceOf(MailingListError);
      expect((error as MailingListError).code).toBe("MAILING_LIST_INVALID_TOKEN");
    }
  });

  it("broadcast enqueues exactly one delivery per SUBSCRIBED recipient", async () => {
    const list = insertList(db, { name: "Weekly" });

    // A confirmed subscriber — should receive the broadcast.
    const ada = lists.subscribe(list.id, "ada@example.com");
    lists.confirm(ada.token!);

    // A second confirmed subscriber.
    const grace = lists.subscribe(list.id, "grace@example.com");
    lists.confirm(grace.token!);

    // A still-pending subscriber — must be skipped.
    lists.subscribe(list.id, "pending@example.com");

    // An unsubscribed subscriber — must be skipped.
    const gone = lists.subscribe(list.id, "gone@example.com");
    lists.confirm(gone.token!);
    lists.unsubscribe(gone.token!);

    const count = lists.broadcast(list.id, "digest", { issue: 42 });
    expect(count).toBe(2);

    await deliverAll();

    const recipients = sent.map((email) => email.to).toSorted();
    expect(recipients).toEqual(["ada@example.com", "grace@example.com"]);
    expect(sent.every((email) => email.subject === "Issue #42")).toBe(true);
  });

  it("defaults to a random hex token generator when none is injected", () => {
    const defaults = createMailingLists({ db, mailer });
    const list = insertList(db, { name: "Weekly" });

    const subscriber = defaults.subscribe(list.id, "ada@example.com");

    // 16 random bytes → 32 hex characters.
    expect(subscriber.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("the migration's down drops both tables", () => {
    const migrator = new Migrator(sql, [mailingListsMigration]);

    expect(migrator.rollback()).toBe(mailingListsMigration.version);
    expect(() => raw.prepare("SELECT * FROM lists").all()).toThrow();
    expect(() => raw.prepare("SELECT * FROM subscribers").all()).toThrow();
  });

  it("insertList accepts a null name (the column is nullable)", () => {
    const list = insertList(db, { name: null });

    expect(list.name).toBeNull();
  });
});
