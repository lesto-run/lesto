/**
 * Resolve the capability-token signing secret for the LOCAL Node tools (`serve.ts`
 * and `mint.ts`), from one place so the two can never drift.
 *
 * Fail CLOSED — matching the Cloudflare path (`alchemy.run.ts` throws when
 * `PUBSUB_SECRET` is unset): a server that silently signed with a publicly-known key
 * would accept forged tokens for every channel and mode. So an unset secret is an
 * error UNLESS the operator explicitly opts into the insecure dev key with
 * `PUBSUB_ALLOW_INSECURE=1` — a one-time local convenience, never a deployment.
 */

/** The publicly-known key used only under `PUBSUB_ALLOW_INSECURE=1` — NEVER for anything real. */
export const DEV_INSECURE_SECRET = "dev-insecure-secret";

/** The real `PUBSUB_SECRET`, or the dev key iff explicitly opted in; otherwise throw. */
export function resolveSecret(): string {
  const secret = process.env.PUBSUB_SECRET;

  if (secret !== undefined && secret !== "") {
    return secret;
  }

  if (process.env.PUBSUB_ALLOW_INSECURE === "1") {
    console.warn(
      "⚠️  PUBSUB_SECRET is unset — using the PUBLICLY-KNOWN insecure dev key (PUBSUB_ALLOW_INSECURE=1). Never do this for a real deployment.",
    );

    return DEV_INSECURE_SECRET;
  }

  throw new Error(
    "PUBSUB_SECRET is required. Set it to a real secret, or set PUBSUB_ALLOW_INSECURE=1 to use the insecure dev key for local drive.",
  );
}
