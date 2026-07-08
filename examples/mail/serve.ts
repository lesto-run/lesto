/**
 * Serve the mail app over LIVE HTTP on Node, on a file-backed SQLite queue.
 *
 *   bun run examples/mail/serve.ts
 *
 * The Cloudflare `send_email` binding is EDGE-ONLY (it lives on the Worker
 * `env`), so this Node leg cannot use it. It picks a Node-runnable transport
 * instead — the SAME app (`bootMail`), a different transport:
 *
 *   - `RESEND_API_KEY` set → deliver over the Resend HTTP API
 *     (`createFetchProviderTransport`); mail lands in a real inbox.
 *   - unset → a transport that logs each rendered email, so the server runs out
 *     of the box with nothing installed.
 *
 * `POST /send` drains the queue in-request (the edge shape), so this leg needs no
 * background worker and behaves identically to the deployed Worker.
 *
 * Drive it:
 *   curl -X POST localhost:3000/send -H 'content-type: application/json' -d '{"to":"you@example.com"}'
 *   curl localhost:3000/health
 */

import { createApp } from "@lesto/kernel";
import { createFetchProviderTransport } from "@lesto/mail";
import type { MailTransport, RenderedEmail } from "@lesto/mail";
import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";

import { bootMail, DEFAULT_FROM } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "./mail.db";

/** Resend when `RESEND_API_KEY` is set; otherwise log what would be sent. */
function buildTransport(): MailTransport {
  const apiKey = process.env.RESEND_API_KEY;

  if (apiKey !== undefined) {
    return createFetchProviderTransport({
      endpoint: "https://api.resend.com/emails",
      apiKey,
      defaultFrom: DEFAULT_FROM,
    });
  }

  return {
    send: async (email: RenderedEmail): Promise<void> => {
      console.log(`\n[mail] → ${email.to}: ${email.subject}`);
    },
  };
}

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite(DB_PATH);

  // `bootMail` returns a bare `@lesto/web` app; `createApp` (@lesto/kernel) wraps
  // it into the kernel `App` a Node server needs — the same lift `examples/cache`
  // does. The worker path serves the bare app directly via `toFetchHandler`.
  // The label matches the transport actually chosen, so `/health` tells the truth
  // on this leg (Resend/console) rather than claiming the edge's CF binding.
  const transportLabel = process.env.RESEND_API_KEY === undefined ? "console" : "resend";
  const { app: mailApp } = await bootMail({ handle, transport: buildTransport(), transportLabel });
  const app = await createApp({ db: handle, app: mailApp });

  const server = await serveWithGracefulShutdown(app, { port: PORT, onClosed: close });
  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nlistening on ${url}   (db: ${DB_PATH})`);
  console.log(`  GET  ${url}/health`);
  console.log(`  POST ${url}/send   {"to":"you@example.com"}`);
  console.log(
    process.env.RESEND_API_KEY === undefined
      ? "\n(no RESEND_API_KEY — sends are logged, not delivered)"
      : "\n(RESEND_API_KEY set — sends deliver over Resend)",
  );
}

await main();
