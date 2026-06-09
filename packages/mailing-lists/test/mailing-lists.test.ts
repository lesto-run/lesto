import Database from "better-sqlite3";
import { installSchema, Queue } from "@keel/queue";
import { resetConnection, useDatabase } from "@keel/orm";
import { Mailer } from "@keel/mail";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { List, MailingListError, MailingLists, Subscriber } from "../src/index";

import type { SqlDatabase as OrmDatabase, SqlStatement } from "@keel/orm";
import type { SqlDatabase as QueueDatabase } from "@keel/queue";
import type { RenderedEmail } from "@keel/mail";

// The DI boundary: @keel/orm speaks "array of positional params"; this adapter
// maps that onto better-sqlite3's variadic bind. @keel/queue, by contrast, binds
// NAMED params, so it gets the raw Database directly. Both share one Database.
function adapt(raw: Database.Database): OrmDatabase {
  return {
    prepare(sql: string): SqlStatement {
      const statement = raw.prepare(sql);

      return {
        run: (params = []) => statement.run(...(params as never[])),
        get: (params = []) => statement.get(...(params as never[])),
        all: (params = []) => statement.all(...(params as never[])),
      };
    },
  };
}

let raw: Database.Database;
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

  // The package's own tables — created by the app, not by the package.
  raw.exec(`
    CREATE TABLE lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT
    );

    CREATE TABLE subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL,
      token TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);

  // ORM sees the positional adapter; queue sees the raw, named-param Database.
  useDatabase(adapt(raw));
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
  lists = new MailingLists({ mailer, token: () => `token-${++n}` });
});

afterEach(() => {
  resetConnection();
  raw.close();
});

describe("MailingLists", () => {
  it("subscribe creates a pending subscriber carrying a fresh token", () => {
    const list = List.create({ name: "Weekly" });

    const subscriber = lists.subscribe(list.id as number, "ada@example.com");

    expect(subscriber).toBeInstanceOf(Subscriber);
    expect(subscriber.get("status")).toBe("pending");
    expect(subscriber.get("email")).toBe("ada@example.com");
    expect(subscriber.get("list_id")).toBe(list.id);
    expect(subscriber.get("token")).toBe("token-1");
  });

  it("confirm flips a pending subscriber to subscribed", () => {
    const list = List.create({ name: "Weekly" });
    const subscriber = lists.subscribe(list.id as number, "ada@example.com");

    const confirmed = lists.confirm(subscriber.get("token") as string);

    expect(confirmed.get("status")).toBe("subscribed");
    expect(Subscriber.find(subscriber.id).get("status")).toBe("subscribed");
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
    const list = List.create({ name: "Weekly" });
    const subscriber = lists.subscribe(list.id as number, "ada@example.com");
    lists.confirm(subscriber.get("token") as string);

    const removed = lists.unsubscribe(subscriber.get("token") as string);

    expect(removed.get("status")).toBe("unsubscribed");
    expect(Subscriber.find(subscriber.id).get("status")).toBe("unsubscribed");
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
    const list = List.create({ name: "Weekly" });

    // A confirmed subscriber — should receive the broadcast.
    const ada = lists.subscribe(list.id as number, "ada@example.com");
    lists.confirm(ada.get("token") as string);

    // A second confirmed subscriber.
    const grace = lists.subscribe(list.id as number, "grace@example.com");
    lists.confirm(grace.get("token") as string);

    // A still-pending subscriber — must be skipped.
    lists.subscribe(list.id as number, "pending@example.com");

    // An unsubscribed subscriber — must be skipped.
    const gone = lists.subscribe(list.id as number, "gone@example.com");
    lists.confirm(gone.get("token") as string);
    lists.unsubscribe(gone.get("token") as string);

    const count = lists.broadcast(list.id as number, "digest", { issue: 42 });
    expect(count).toBe(2);

    await deliverAll();

    const recipients = sent.map((email) => email.to).toSorted();
    expect(recipients).toEqual(["ada@example.com", "grace@example.com"]);
    expect(sent.every((email) => email.subject === "Issue #42")).toBe(true);
  });

  it("defaults to a random hex token generator when none is injected", () => {
    const defaults = new MailingLists({ mailer });
    const list = List.create({ name: "Weekly" });

    const subscriber = defaults.subscribe(list.id as number, "ada@example.com");

    // 16 random bytes → 32 hex characters.
    expect(subscriber.get("token")).toMatch(/^[0-9a-f]{32}$/);
  });
});
