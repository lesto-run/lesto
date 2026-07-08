/**
 * The mail app: a `@lesto/mail` Mailer riding a `@lesto/queue` over one SQL
 * handle, fronted by two `@lesto/web` routes.
 *
 *   GET  /health   report the wired transport + sender (no send)
 *   POST /send      { "to": "..." }   enqueue the welcome email, drain, report
 *
 * `bootMail` is the shared wiring the worker (edge, D1), serve.ts (Node, SQLite),
 * and the test all reuse: install the queue schema, stand up the Queue + Mailer +
 * transport, register the `welcome` template. It is transport-agnostic — the
 * caller injects a `MailTransport` (the Cloudflare `send_email` binding on the
 * edge; a Resend provider or a console logger on Node; a fake in tests).
 *
 * Delivery is drained IN-REQUEST (`while (await queue.runOnce())`) rather than by
 * a long-running worker, because a Cloudflare Worker has no steady process to run
 * a drain loop on. `/send` enqueues with `maxAttempts: 1` so a single attempt
 * yields an immediate, honest verdict — `delivered: true`, or `delivered: false`
 * with the failure reason (the transport error MESSAGE, from `job.lastError` — not
 * the machine code; e.g. the sender domain not being onboarded yet).
 */

import { Mailer } from "@lesto/mail";
import type { MailTransport } from "@lesto/mail";
import { installSchema, Queue } from "@lesto/queue";
import type { SqlDatabase } from "@lesto/queue";
import { lesto } from "@lesto/web";
import type { Lesto } from "@lesto/web";

import { defineWelcome } from "./mailers";

/** The onboarded Cloudflare Email Sending sender this demo delivers from. */
export const DEFAULT_FROM = "hello@lesto.run";

export interface BootOptions {
  /** A SQL handle: `d1ToSqlDatabase(env.DB)` on the edge, `openSqlite` on Node. */
  readonly handle: SqlDatabase;

  /** Where rendered mail is delivered — the CF binding, a provider, or a fake. */
  readonly transport: MailTransport;

  /**
   * A label for the wired transport, echoed by `GET /health`. Passed by the
   * caller (`"cloudflare-email"` on the edge; `"resend"`/`"console"` on Node) so
   * `/health` reports what is ACTUALLY wired — the `MailTransport` interface
   * carries no name, and a hardcoded label would let the Node leg misreport.
   */
  readonly transportLabel: string;
}

export interface Booted {
  readonly app: Lesto;
  readonly queue: Queue;
}

/** Boot the queue + mailer + routes over one handle and one transport. */
export async function bootMail(options: BootOptions): Promise<Booted> {
  const { handle, transport, transportLabel } = options;

  await installSchema(handle);

  const queue = new Queue({ db: handle });
  const mailer = new Mailer({ queue, transport, defaultFrom: DEFAULT_FROM });
  const welcome = defineWelcome(mailer);

  const app = lesto()
    .get("/health", (c) => c.json({ ok: true, transport: transportLabel, from: DEFAULT_FROM }))
    .post("/send", async (c) => {
      const to = (c.req.body as { to?: unknown } | null)?.to;

      if (typeof to !== "string" || to.length === 0) {
        return c.json({ error: "A `to` address is required." }, 422);
      }

      // One attempt: `/send` reports an immediate verdict rather than parking a
      // retry with backoff the caller can't observe.
      const jobId = await welcome.send({ to }, { maxAttempts: 1 });

      // Drain in-request — a Worker has no long-running worker loop. `runOnce`
      // catches a handler/transport throw and routes it through the queue's
      // fail() path, so this loop never throws; it returns null when empty.
      while (await queue.runOnce()) {
        // keep draining
      }

      const job = await queue.find(jobId);
      const delivered = job?.status === "done";

      return c.json({
        jobId,
        delivered,
        ...(job?.lastError === undefined || job.lastError === null ? {} : { error: job.lastError }),
      });
    });

  return { app, queue };
}
