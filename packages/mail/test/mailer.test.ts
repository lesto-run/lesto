import Database from "better-sqlite3";
import { installSchema, Queue } from "@keel/queue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Mailer, MailError } from "../src/index";

import type { SqlDatabase } from "@keel/queue";
import type { RenderedEmail } from "../src/index";

let raw: Database.Database;
let queue: Queue;
let sent: RenderedEmail[];
const transport = {
  send: async (email: RenderedEmail): Promise<void> => {
    sent.push(email);
  },
};

beforeEach(() => {
  raw = new Database(":memory:");
  const db = raw as unknown as SqlDatabase;
  installSchema(db);
  queue = new Queue({ db });
  sent = [];
});

afterEach(() => {
  raw.close();
});

describe("Mailer", () => {
  it("queues and delivers an html email with the default from", async () => {
    const mailer = new Mailer({ queue, transport, defaultFrom: "hi@app.com" });
    mailer.define<{ to: string; name: string }>("welcome", ({ to, name }) => ({
      to,
      subject: "Welcome",
      html: `<p>Hi ${name}</p>`,
    }));

    const id = await mailer.send("welcome", { to: "ada@example.com", name: "Ada" });
    expect(typeof id).toBe("number");

    expect((await queue.runOnce())?.outcome).toBe("done");
    expect(sent).toEqual([
      { to: "ada@example.com", subject: "Welcome", html: "<p>Hi Ada</p>", from: "hi@app.com" },
    ]);
  });

  it("renders a react template via the injected renderer, honoring an explicit from", async () => {
    const mailer = new Mailer({
      queue,
      transport,
      defaultFrom: "hi@app.com",
      render: (element) => `rendered:${JSON.stringify(element)}`,
    });
    mailer.define("digest", () => ({
      to: "team@example.com",
      from: "noreply@app.com",
      subject: "Digest",
      react: { kind: "Digest" },
    }));

    await mailer.send("digest", {});
    await queue.runOnce();

    expect(sent[0]?.from).toBe("noreply@app.com");
    expect(sent[0]?.html).toBe(`rendered:${JSON.stringify({ kind: "Digest" })}`);
  });

  it("omits `from` when neither the email nor the mailer sets one", async () => {
    const mailer = new Mailer({ queue, transport });
    mailer.define("bare", () => ({ to: "x@example.com", subject: "Bare", html: "<p>.</p>" }));

    await mailer.send("bare", {});
    await queue.runOnce();

    expect(sent[0]?.from).toBeUndefined();
  });

  it("fails (coded) for an unknown mailer", async () => {
    const mailer = new Mailer({ queue, transport });
    const id = await mailer.send("ghost", {}, { maxAttempts: 1 });

    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect((await queue.find(id))?.lastError).toContain('No mailer named "ghost"');
  });

  it("fails when the template has no body", async () => {
    const mailer = new Mailer({ queue, transport });
    mailer.define("empty", () => ({ to: "x@example.com", subject: "Empty" }));
    const id = await mailer.send("empty", {}, { maxAttempts: 1 });

    await queue.runOnce();
    expect((await queue.find(id))?.lastError).toContain("html` or `react");
  });

  it("fails when a react template has no renderer", async () => {
    const mailer = new Mailer({ queue, transport });
    mailer.define("needsRender", () => ({ to: "x@example.com", subject: "R", react: {} }));
    const id = await mailer.send("needsRender", {}, { maxAttempts: 1 });

    await queue.runOnce();
    expect((await queue.find(id))?.lastError).toContain("react-email");
  });

  it("MailError carries a frozen, coded payload", () => {
    const error = new MailError("MAIL_EMPTY_BODY", "boom", { a: 1 });

    expect(error.code).toBe("MAIL_EMPTY_BODY");
    expect(Object.isFrozen(error.details)).toBe(true);
  });
});
