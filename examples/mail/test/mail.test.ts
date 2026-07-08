/**
 * The mail example's QA gate — drives the routes in-process over the SAME edge
 * transport the Worker uses (`createCloudflareEmailTransport`), fed a FAKE
 * `send_email` binding. So this proves the whole chain the deploy relies on —
 * enqueue → in-request drain → the Cloudflare-Email transport → the binding — and
 * the honest fail-closed verdict when the binding rejects, without any network or
 * real domain.
 */

import { afterEach, describe, expect, it } from "vitest";

import { createCloudflareEmailTransport } from "@lesto/mail";
import type { CloudflareEmailMessage } from "@lesto/mail";
import { openSqlite } from "@lesto/runtime";

import { bootMail, DEFAULT_FROM } from "../src/app";
import type { Booted } from "../src/app";

interface SendResult {
  readonly jobId: number;
  readonly delivered: boolean;
  readonly error?: string;
}

describe("@lesto/mail example — the mail app over the Cloudflare-Email transport", () => {
  let close: () => void;

  afterEach(() => {
    close();
  });

  /** Boot the app over an in-memory queue with a binding that either records or throws. */
  async function boot(binding: {
    send: (m: CloudflareEmailMessage) => Promise<unknown>;
  }): Promise<Booted> {
    const opened = await openSqlite();
    close = opened.close;

    return bootMail({
      handle: opened.db,
      transport: createCloudflareEmailTransport({ binding }),
      transportLabel: "cloudflare-email",
    });
  }

  it("GET /health reports the wired transport and sender", async () => {
    const { app } = await boot({ send: async () => ({}) });

    const res = await app.handle("GET", "/health");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({
      ok: true,
      transport: "cloudflare-email",
      from: DEFAULT_FROM,
    });
  });

  it("POST /send delivers through the binding and reports delivered:true", async () => {
    const sent: CloudflareEmailMessage[] = [];
    const { app } = await boot({
      send: async (m) => {
        sent.push(m);

        return {};
      },
    });

    const res = await app.handle("POST", "/send", { body: { to: "ada@example.com" } });

    expect(res.status).toBe(200);
    const result = JSON.parse(res.body as string) as SendResult;
    expect(result.delivered).toBe(true);
    expect(result.error).toBeUndefined();

    // The message actually reached the binding, from the onboarded sender.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("ada@example.com");
    expect(sent[0]?.from).toEqual({ email: DEFAULT_FROM });
    expect(sent[0]?.subject).toBe("Welcome to Lesto");
  });

  it("POST /send reports delivered:false with the coded reason when the binding rejects", async () => {
    const { app } = await boot({
      send: async () => {
        throw new Error("email not enabled for domain");
      },
    });

    const res = await app.handle("POST", "/send", { body: { to: "ada@example.com" } });

    // The route still 200s (the send was attempted) but tells the truth.
    expect(res.status).toBe(200);
    const result = JSON.parse(res.body as string) as SendResult;
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("Cloudflare Email Sending rejected");
  });

  it("POST /send rejects a missing/blank `to` with 422 before enqueueing", async () => {
    const sent: CloudflareEmailMessage[] = [];
    const { app } = await boot({
      send: async (m) => {
        sent.push(m);

        return {};
      },
    });

    const missing = await app.handle("POST", "/send", { body: {} });
    expect(missing.status).toBe(422);

    const blank = await app.handle("POST", "/send", { body: { to: "" } });
    expect(blank.status).toBe(422);

    // Nothing was enqueued or sent.
    expect(sent).toEqual([]);
  });
});
