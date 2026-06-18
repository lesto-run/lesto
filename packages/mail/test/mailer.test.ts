import Database from "better-sqlite3";
import { installSchema, Queue } from "@volo/queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Mailer,
  MailError,
  assertHeaders,
  assertNoInjection,
  failureCode,
  messageIdFor,
} from "../src/index";

import type { SqlDatabase } from "@volo/queue";
import type { DeliveryEvent, DeliveryFailure, RenderedEmail } from "../src/index";

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
  it("queues and delivers an html email with the default from and a stable messageId", async () => {
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
      {
        to: "ada@example.com",
        subject: "Welcome",
        html: "<p>Hi Ada</p>",
        from: "hi@app.com",
        messageId: messageIdFor(id),
      },
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

  it("carries text and headers through to the transport", async () => {
    const mailer = new Mailer({ queue, transport, defaultFrom: "hi@app.com" });
    mailer.define("multi", () => ({
      to: "x@example.com",
      subject: "Multi",
      html: "<p>hi</p>",
      text: "hi",
      headers: { "Reply-To": "support@app.com", "List-Unsubscribe": "<https://app.com/u>" },
    }));

    await mailer.send("multi", {});
    await queue.runOnce();

    expect(sent[0]?.text).toBe("hi");
    expect(sent[0]?.headers).toEqual({
      "Reply-To": "support@app.com",
      "List-Unsubscribe": "<https://app.com/u>",
    });
  });

  it("omits `from` when neither the email nor the mailer sets one", async () => {
    const mailer = new Mailer({ queue, transport });
    mailer.define("bare", () => ({ to: "x@example.com", subject: "Bare", html: "<p>.</p>" }));

    await mailer.send("bare", {});
    await queue.runOnce();

    expect(sent[0]?.from).toBeUndefined();
  });

  it("auto-fills the multipart text part from a renderer that returns { html, text }", async () => {
    const mailer = new Mailer({
      queue,
      transport,
      render: () => ({ html: "<p>Hi</p>", text: "Hi" }),
    });
    mailer.define("welcome", () => ({ to: "x@example.com", subject: "Hi", react: {} }));

    await mailer.send("welcome", {});
    await queue.runOnce();

    expect(sent[0]?.html).toBe("<p>Hi</p>");
    expect(sent[0]?.text).toBe("Hi");
  });

  it("lets an explicit email.text win over a renderer-supplied text", async () => {
    const mailer = new Mailer({
      queue,
      transport,
      render: () => ({ html: "<p>Hi</p>", text: "auto" }),
    });
    mailer.define("welcome", () => ({
      to: "x@example.com",
      subject: "Hi",
      react: {},
      text: "explicit",
    }));

    await mailer.send("welcome", {});
    await queue.runOnce();

    expect(sent[0]?.text).toBe("explicit");
  });

  it("template() binds params for type-safe sends and delivers like define+send", async () => {
    const mailer = new Mailer({ queue, transport, defaultFrom: "hi@app.com" });
    const welcome = mailer.template("welcome", (p: { to: string; name: string }) => ({
      to: p.to,
      subject: `Welcome ${p.name}`,
      html: `<p>Hi ${p.name}</p>`,
    }));

    expect(welcome.name).toBe("welcome");

    const id = await welcome.send({ to: "ada@example.com", name: "Ada" });
    expect((await queue.runOnce())?.outcome).toBe("done");

    expect(sent[0]).toEqual({
      to: "ada@example.com",
      subject: "Welcome Ada",
      html: "<p>Hi Ada</p>",
      from: "hi@app.com",
      messageId: messageIdFor(id),
    });
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

describe("Mailer — header injection guard", () => {
  it.each([
    ["to", { to: "a@x.com\r\nBcc: evil@x.com", subject: "S", html: "<p>.</p>" }, "`to`"],
    ["subject", { to: "a@x.com", subject: "S\nX-Spam: yes", html: "<p>.</p>" }, "`subject`"],
    [
      "from",
      { to: "a@x.com", subject: "S", from: "x@x.com\r\nEvil: 1", html: "<p>.</p>" },
      "`from`",
    ],
  ])("refuses CRLF in %s at deliver time", async (_field, email, marker) => {
    const mailer = new Mailer({ queue, transport });
    mailer.define("inject", () => email as never);
    const id = await mailer.send("inject", {}, { maxAttempts: 1 });

    await queue.runOnce();
    const found = await queue.find(id);
    expect(found?.lastError).toContain(marker);
    expect(found?.lastError).toContain("header injection");
    expect(sent).toHaveLength(0);
  });

  it("refuses CRLF in a header value", async () => {
    const mailer = new Mailer({ queue, transport });
    mailer.define("badHeader", () => ({
      to: "a@x.com",
      subject: "S",
      html: "<p>.</p>",
      headers: { "X-Thing": "ok\r\nInjected: 1" },
    }));
    const id = await mailer.send("badHeader", {}, { maxAttempts: 1 });

    await queue.runOnce();
    expect((await queue.find(id))?.lastError).toContain("header X-Thing");
  });

  it("refuses CRLF in a header name", async () => {
    const mailer = new Mailer({ queue, transport });
    mailer.define("badHeaderName", () => ({
      to: "a@x.com",
      subject: "S",
      html: "<p>.</p>",
      headers: { "X-Thing\r\nInjected": "1" },
    }));
    const id = await mailer.send("badHeaderName", {}, { maxAttempts: 1 });

    await queue.runOnce();
    expect((await queue.find(id))?.lastError).toContain("header name");
  });

  it("validates a defaultFrom-overriding bad address (the from branch)", async () => {
    const mailer = new Mailer({ queue, transport, defaultFrom: "ok@app.com\r\nEvil: 1" });
    mailer.define("usesDefault", () => ({ to: "a@x.com", subject: "S", html: "<p>.</p>" }));
    const id = await mailer.send("usesDefault", {}, { maxAttempts: 1 });

    await queue.runOnce();
    expect((await queue.find(id))?.lastError).toContain("`from`");
  });
});

describe("Mailer — unknown mailer is parked, not retried", () => {
  it("completes the current job and re-enqueues a delayed copy on deploy skew", async () => {
    const mailer = new Mailer({ queue, transport, unknownMailerParkMs: 1_000 });
    const id = await mailer.send("ghost", {}, { maxAttempts: 1 });

    // The original job completes successfully (not failed) — no attempt burned.
    expect((await queue.runOnce())?.outcome).toBe("done");
    expect((await queue.find(id))?.status).toBe("done");

    // A delayed replacement now waits; immediately it is not yet eligible.
    expect(await queue.runOnce()).toBeNull();
  });

  it("eventually fails loudly once the park budget is exhausted", async () => {
    const mailer = new Mailer({
      queue,
      transport,
      unknownMailerParkMs: 0,
      maxUnknownMailerParks: 2,
    });
    await mailer.send("ghost", {}, { maxAttempts: 1 });

    // park 1 → done + re-enqueue, park 2 → done + re-enqueue, park 3 → exceeds budget → failed.
    expect((await queue.runOnce())?.outcome).toBe("done");
    expect((await queue.runOnce())?.outcome).toBe("done");
    const result = await queue.runOnce();
    expect(result?.outcome).toBe("failed");
    expect((await queue.find(result!.job.id))?.lastError).toContain('No mailer named "ghost"');
  });
});

describe("header guard helpers", () => {
  it("assertNoInjection passes a clean value and throws on CRLF", () => {
    expect(() => assertNoInjection("to", "a@x.com", "MAIL_INVALID_ADDRESS")).not.toThrow();
    expect(() => assertNoInjection("to", "a@x.com\n", "MAIL_INVALID_ADDRESS")).toThrow(MailError);
  });

  it("assertHeaders returns the headers unchanged when clean", () => {
    const headers = { "X-A": "1", "X-B": "2" };
    expect(assertHeaders(headers)).toBe(headers);
  });

  it("messageIdFor derives a stable id from a job id", () => {
    expect(messageIdFor(42)).toBe("volo-mail-42");
  });

  it("failureCode surfaces a MailError's code and collapses anything else", () => {
    expect(failureCode(new MailError("MAIL_EMPTY_BODY", "x"))).toBe("MAIL_EMPTY_BODY");
    expect(failureCode(new Error("socket reset"))).toBe("MAIL_TRANSPORT_ERROR");
    expect(failureCode("not an error")).toBe("MAIL_TRANSPORT_ERROR");
  });
});

describe("Mailer — delivery observability hooks", () => {
  it("fires onDelivered with a PII-free { mailerName, jobId, attempt } after the transport accepts", async () => {
    const delivered: DeliveryEvent[] = [];
    const mailer = new Mailer({
      queue,
      transport,
      defaultFrom: "hi@app.com",
      onDelivered: (event) => {
        delivered.push(event);
      },
    });
    mailer.define("welcome", () => ({
      to: "ada@example.com",
      subject: "Top secret subject",
      html: "<p>private body</p>",
    }));

    const id = await mailer.send("welcome", {});
    expect((await queue.runOnce())?.outcome).toBe("done");

    // Exactly the operational ids — nothing more.
    expect(delivered).toEqual([{ mailerName: "welcome", jobId: id, attempt: 1 }]);

    // The payload leaks no recipient address, subject, or body.
    const blob = JSON.stringify(delivered);
    expect(blob).not.toContain("ada@example.com");
    expect(blob).not.toContain("Top secret subject");
    expect(blob).not.toContain("private body");

    // It really delivered, too.
    expect(sent).toHaveLength(1);
  });

  it("fires onFailed (not onDelivered) with a coded reason when the build/render fails", async () => {
    const delivered: DeliveryEvent[] = [];
    const failed: DeliveryFailure[] = [];
    const mailer = new Mailer({
      queue,
      transport,
      onDelivered: (e) => {
        delivered.push(e);
      },
      onFailed: (f) => {
        failed.push(f);
      },
    });
    // No html, no react → MAIL_EMPTY_BODY at render time.
    mailer.define("broken", () => ({ to: "ada@example.com", subject: "S" }));

    const id = await mailer.send("broken", {}, { maxAttempts: 1 });
    expect((await queue.runOnce())?.outcome).toBe("failed");

    expect(delivered).toHaveLength(0);
    expect(failed).toEqual([
      { mailerName: "broken", jobId: id, attempt: 1, code: "MAIL_EMPTY_BODY" },
    ]);
    // PII-free even on the failure path.
    expect(JSON.stringify(failed)).not.toContain("ada@example.com");
  });

  it("classifies a transport reject as MAIL_TRANSPORT_ERROR and lets the queue retry", async () => {
    const failed: DeliveryFailure[] = [];
    const rejectingTransport = {
      send: async (): Promise<void> => {
        throw new Error("connection refused");
      },
    };
    const mailer = new Mailer({
      queue,
      transport: rejectingTransport,
      onFailed: (f) => {
        failed.push(f);
      },
    });
    mailer.define("rejects", () => ({ to: "x@example.com", subject: "S", html: "<p>.</p>" }));

    await mailer.send("rejects", {}, { maxAttempts: 1 });
    expect((await queue.runOnce())?.outcome).toBe("failed");

    expect(failed).toHaveLength(1);
    expect(failed[0]?.code).toBe("MAIL_TRANSPORT_ERROR");
  });

  it("threads the attempt number across an at-least-once retry", async () => {
    // A zero backoff makes the retried job immediately eligible for runOnce.
    const fastQueue = new Queue({ db: raw as unknown as SqlDatabase, baseBackoffMs: 0 });
    const events: DeliveryEvent[] = [];
    let calls = 0;
    const flakyTransport = {
      send: async (): Promise<void> => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
      },
    };
    const mailer = new Mailer({
      queue: fastQueue,
      transport: flakyTransport,
      onDelivered: (e) => {
        events.push({ ...e, mailerName: `delivered:${e.mailerName}` });
      },
      onFailed: (f) => {
        events.push({ ...f, mailerName: `failed:${f.mailerName}` });
      },
    });
    mailer.define("flaky", () => ({ to: "x@example.com", subject: "S", html: "<p>.</p>" }));

    const id = await mailer.send("flaky", {}, { maxAttempts: 3 });

    // Attempt 1 rejects → retry scheduled.
    expect((await fastQueue.runOnce())?.outcome).toBe("retry");
    // Attempt 2 succeeds.
    expect((await fastQueue.runOnce())?.outcome).toBe("done");

    expect(events).toEqual([
      { mailerName: "failed:flaky", jobId: id, attempt: 1, code: "MAIL_TRANSPORT_ERROR" },
      { mailerName: "delivered:flaky", jobId: id, attempt: 2 },
    ]);
  });

  it("does NOT fire either hook for a parked unknown mailer", async () => {
    const onDelivered = vi.fn();
    const onFailed = vi.fn();
    const mailer = new Mailer({
      queue,
      transport,
      unknownMailerParkMs: 1_000,
      onDelivered,
      onFailed,
    });

    await mailer.send("ghost", {}, { maxAttempts: 1 });
    expect((await queue.runOnce())?.outcome).toBe("done");

    expect(onDelivered).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("fires onFailed when the unknown-mailer park budget is finally exhausted", async () => {
    const failed: DeliveryFailure[] = [];
    const mailer = new Mailer({
      queue,
      transport,
      unknownMailerParkMs: 0,
      maxUnknownMailerParks: 1,
      onFailed: (f) => {
        failed.push(f);
      },
    });
    await mailer.send("ghost", {}, { maxAttempts: 1 });

    // park 1 → done (no hook), park 2 → exceeds budget → failed (hook fires).
    expect((await queue.runOnce())?.outcome).toBe("done");
    expect((await queue.runOnce())?.outcome).toBe("failed");

    expect(failed).toHaveLength(1);
    expect(failed[0]?.code).toBe("MAIL_UNKNOWN_MAILER");
  });

  it("swallows a throwing onDelivered so the delivery still succeeds", async () => {
    const mailer = new Mailer({
      queue,
      transport,
      onDelivered: () => {
        throw new Error("metrics sink down");
      },
    });
    mailer.define("ok", () => ({ to: "x@example.com", subject: "S", html: "<p>.</p>" }));

    await mailer.send("ok", {}, { maxAttempts: 1 });
    // A broken hook must not turn a real delivery into a failure/retry.
    expect((await queue.runOnce())?.outcome).toBe("done");
    expect(sent).toHaveLength(1);
  });

  it("swallows a throwing onFailed so the real error still reaches the queue", async () => {
    const mailer = new Mailer({
      queue,
      transport,
      onFailed: () => {
        throw new Error("metrics sink down");
      },
    });
    // MAIL_EMPTY_BODY is the real failure; the hook's throw must not mask it.
    mailer.define("broken", () => ({ to: "x@example.com", subject: "S" }));

    const id = await mailer.send("broken", {}, { maxAttempts: 1 });
    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect((await queue.find(id))?.lastError).toContain("html` or `react");
  });
});
