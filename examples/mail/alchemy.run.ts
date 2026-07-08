/**
 * Deploy the mail example to Cloudflare with Alchemy (ADR 0044) — TypeScript IaC.
 *
 *   bunx alchemy login            # one-time: Alchemy needs its OWN CF creds
 *   bun alchemy.run.ts            # deploy   → prints the live url
 *   bun alchemy.run.ts --destroy  # tear down
 *
 * One Worker (`worker.ts`) with two bindings: a D1 database for the mail queue,
 * and Cloudflare Email Sending's `send_email` binding (`EmailSender()` → the
 * Worker's `env.EMAIL`).
 *
 * ## What this deploy proves — and what it does NOT
 *
 * After `finalize()` the post-deploy smoke asserts the Worker DEPLOYS, BOOTS, and
 * serves `GET /health` → 200. Booting runs `bootMail`, which installs the queue
 * schema on D1 — so a green `/health` proves the D1 schema install works on the
 * real edge substrate (the exact thing that silently breaks if a multi-statement
 * DDL is pushed through D1's single-statement `exec`). That is the honest live claim.
 *
 * It does NOT assert a real email was delivered, nor even that the enqueue/drain
 * path runs on D1 (that is covered by the local test over a fake binding — see
 * `test/mail.test.ts`). Cloudflare Email Sending only accepts a `from` on an
 * ONBOARDED domain (`wrangler email sending enable lesto.run` + the SPF/DKIM/DMARC
 * DNS records), and a delivered message can only be confirmed by reading the
 * destination inbox — which CI cannot do. So the real send is the one manual hop
 * (mirroring estate's "one unautomated hop" honesty); asserting it here would be a
 * vacuous green. Until the domain is onboarded, `POST /send` truthfully returns
 * `delivered: false` with the failure reason.
 */

import alchemy from "alchemy";
import { D1Database, EmailSender, Worker } from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";

const app = await alchemy("lesto-example-mail", {
  stateStore: (scope) =>
    new CloudflareStateStore(scope, {
      forceUpdate: process.env.ALCHEMY_STATE_FORCE_UPDATE === "1",
    }),
});

// The D1 database backing the mail queue. `adopt: true` so a re-deploy reuses it.
const db = await D1Database("mail-queue-db", {
  name: `${app.name}-${app.stage}-db`,
  adopt: true,
});

const worker = await Worker("mail-edge", {
  name: `${app.name}-${app.stage}`,
  entrypoint: "worker.ts",
  // `EmailSender()` is the Cloudflare Email Sending binding — it becomes the
  // Worker's `env.EMAIL`. The sender domain is enforced by onboarding, not here.
  bindings: { DB: db, EMAIL: EmailSender() },
  url: true,
  compatibilityDate: "2025-06-01",
  compatibilityFlags: ["nodejs_compat"],
});

const url = worker.url;
if (url === undefined) throw new Error("mail Worker has no url (expected `url: true`)");

console.log("mail edge:", url);
console.log("  GET  ", `${url}/health`);
console.log("  POST ", `${url}/send   {"to":"you@example.com"}`);

await app.finalize();

await verifyLive(url);

/**
 * Post-deploy smoke: prove the Worker boots and serves `GET /health` → 200 (which
 * means `bootMail` — including the D1 queue-schema install — succeeded on the real
 * edge substrate). Retried with backoff to absorb cold-start + the post-deploy
 * propagation window. Deliberately does NOT assert the transport string (a
 * constant `/health` echoes — not a proof) and does NOT send — see the header note.
 */
async function verifyLive(base: string): Promise<void> {
  const target = `${base}/health`;
  const delaysMs = [500, 1000, 2000, 4000, 8000];

  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    const health = await fetchHealth(target);

    if (health !== undefined) {
      if (health.ok !== true) {
        throw new Error(`smoke: /health returned 200 but ok=${JSON.stringify(health.ok)}`);
      }

      console.log(`smoke: Worker booted + D1 queue schema installed (GET /health 200) ✓`);
      console.log(
        "note: a real send needs `wrangler email sending enable lesto.run` — the manual hop.",
      );

      return;
    }

    const delayMs = delaysMs[attempt];
    if (delayMs === undefined) break;

    console.log(
      `smoke: GET ${target} not ready (attempt ${attempt + 1}); retrying in ${delayMs}ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`smoke: GET ${target} never returned 200 after ${delaysMs.length + 1} attempts`);
}

interface HealthShape {
  readonly ok: unknown;
}

async function fetchHealth(target: string): Promise<HealthShape | undefined> {
  const response = await fetch(target);

  if (!response.ok) return undefined;

  return (await response.json()) as HealthShape;
}
