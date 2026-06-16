/**
 * Serve the mailing-list app over LIVE HTTP, with a real mail transport.
 *
 *   bun run examples/mailing-lists/serve.ts
 *
 * Where run.ts dispatches the journey in-process and captures mail in memory,
 * this boots the same app behind a real node:http server (`@keel/runtime`'s
 * `serve`), starts a `@keel/queue` worker to deliver enqueued mail, and stays up
 * so you can drive the journey by hand and watch the email arrive in a real inbox.
 *
 * Mail transport:
 *   - Set `SMTP_HOST` (e.g. a local Mailpit sink) and every email is delivered
 *     over SMTP — open the sink's web UI to read the confirmation + digest mail,
 *     click the links, and prove the hosted-UX leg end to end.
 *   - Unset, it falls back to a transport that logs each rendered email, so the
 *     server runs out of the box with nothing else installed.
 *
 * Drive it (see README for the Mailpit runbook):
 *   curl -X POST localhost:3000/lists/1/subscribe -H 'content-type: application/json' -d '{"email":"ada@example.com"}'
 *   # open the confirmation email, click the confirm link
 *   curl -X POST localhost:3000/lists/1/broadcast  -H 'content-type: application/json' -d '{"issue":42}'
 */

import { createSmtpTransport, nodeConnect, nodeUpgrade } from "@keel/mail";
import type { MailTransport, RenderedEmail } from "@keel/mail";
import { openSqlite, serve } from "@keel/runtime";

import { buildApp } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;

/** SMTP when `SMTP_HOST` is set (a real sink); otherwise log what would be sent. */
function buildTransport(): MailTransport {
  const host = process.env.SMTP_HOST;

  if (host !== undefined) {
    return createSmtpTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? 1025),
      // A local dev sink (Mailpit/MailHog) speaks plaintext SMTP — no STARTTLS.
      secure: false,
      connect: nodeConnect,
      upgrade: nodeUpgrade,
    });
  }

  return {
    send: async (email: RenderedEmail): Promise<void> => {
      console.log(`\n[mail] → ${email.to}: ${email.subject}`);
      if (email.headers?.["List-Unsubscribe"] !== undefined) {
        console.log(`       List-Unsubscribe: ${email.headers["List-Unsubscribe"]}`);
      }
    },
  };
}

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const { app, queue, list } = await buildApp({
    handle,
    transport: buildTransport(),
    baseUrl: BASE_URL,
  });

  console.log("migrations applied:", app.migrationsApplied);
  console.log(`seeded list #${list.id} (${list.name})`);

  // A real worker drains the mail queue continuously — the production shape, not
  // the one-shot drain run.ts uses.
  const worker = queue.work();

  const server = await serve(app, { port: PORT });
  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nlistening on ${url}`);
  console.log(`  POST ${url}/lists/${list.id}/subscribe   {"email":"…"}   (rate-limited)`);
  console.log(`  GET  ${url}/confirm/:token`);
  console.log(`  POST ${url}/lists/${list.id}/broadcast   {"issue":42}`);
  console.log(`  GET  ${url}/unsubscribe/:token`);
  console.log(
    process.env.SMTP_HOST === undefined
      ? `\nmail: logging to console (set SMTP_HOST to deliver to a real sink)`
      : `\nmail: delivering over SMTP to ${process.env.SMTP_HOST}:${process.env.SMTP_PORT ?? 1025}`,
  );

  const shutdown = async (): Promise<void> => {
    console.log("\nshutting down...");
    await worker.stop();
    await server.close();
    close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
