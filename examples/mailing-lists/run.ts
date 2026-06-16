/**
 * The whole double-opt-in journey, in-process, in one run.
 *
 *   bun run examples/mailing-lists/run.ts
 *
 * It boots the app on an in-memory SQLite database, then dispatches the real
 * journey through the kernel — subscribe, confirm, broadcast, unsubscribe —
 * draining the mail queue between steps so you can watch each email come out.
 * The transport here just captures what would have been sent; serve.ts wires a
 * real SMTP transport so the same journey lands mail in an actual inbox.
 *
 * Note the rate-limiter: keyed by client IP, which the in-process `app.handle`
 * path never establishes, so it would fall back to one shared bucket and warn.
 * We pass a fixed `keyFor` to keep this demo quiet — see the README's DX finding.
 */

import { rateLimit } from "@keel/ratelimit";
import { openSqlite } from "@keel/runtime";
import type { RenderedEmail } from "@keel/mail";

import { buildApp } from "./src/app";

const BASE_URL = "http://127.0.0.1:3000";

/** Pull the token out of a `…/<marker>/<token>` link in rendered mail. */
function extractToken(haystack: string, marker: string): string {
  const at = haystack.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker} link found in email`);

  return haystack.slice(at + marker.length).split(/["'>\s]/)[0] ?? "";
}

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const outbox: RenderedEmail[] = [];
  const transport = {
    send: async (email: RenderedEmail): Promise<void> => {
      outbox.push(email);
    },
  };

  const { app, queue, list } = await buildApp({
    handle,
    transport,
    baseUrl: BASE_URL,
    subscribeLimiter: rateLimit({ capacity: 5, refillPerSecond: 1, keyFor: () => "demo" }),
  });

  console.log("migrations applied:", app.migrationsApplied);
  console.log(`seeded list #${list.id} (${list.name})\n`);

  const drain = async (): Promise<void> => {
    while ((await queue.runOnce()) !== null) {
      // keep draining until the queue is idle
    }
  };

  // 1. Subscribe — pending, confirmation email enqueued.
  const subscribed = await app.handle("POST", `/lists/${list.id}/subscribe`, {
    body: { email: "ada@example.com" },
  });
  console.log(`POST /lists/${list.id}/subscribe -> ${subscribed.status} ${subscribed.body}`);

  await drain();
  const confirmEmail = outbox.at(-1);
  if (confirmEmail === undefined) throw new Error("no confirmation email was delivered");
  console.log(`  → mail: "${confirmEmail.subject}" to ${confirmEmail.to}\n`);

  // 2. Confirm — click the link the recipient received.
  const confirmToken = extractToken(confirmEmail.html, "/confirm/");
  const confirmed = await app.handle("GET", `/confirm/${confirmToken}`);
  console.log(`GET /confirm/${confirmToken} -> ${confirmed.status} (subscribed)\n`);

  // 3. Broadcast — fan issue #42 out to the (now one) subscribed recipient.
  const broadcast = await app.handle("POST", `/lists/${list.id}/broadcast`, {
    body: { issue: 42 },
  });
  console.log(`POST /lists/${list.id}/broadcast -> ${broadcast.status} ${broadcast.body}`);

  await drain();
  const digest = outbox.at(-1);
  if (digest === undefined) throw new Error("no digest email was delivered");
  console.log(`  → mail: "${digest.subject}" to ${digest.to}`);
  console.log(`     List-Unsubscribe: ${digest.headers?.["List-Unsubscribe"]}\n`);

  // 4. Unsubscribe — one-click, from the digest's List-Unsubscribe header.
  const unsubToken = extractToken(digest.headers?.["List-Unsubscribe"] ?? "", "/unsubscribe/");
  const unsubscribed = await app.handle("GET", `/unsubscribe/${unsubToken}`);
  console.log(`GET /unsubscribe/${unsubToken} -> ${unsubscribed.status} (unsubscribed)\n`);

  console.log(`delivered ${outbox.length} emails through the queue.`);

  close();
}

await main();
