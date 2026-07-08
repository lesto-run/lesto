/**
 * Mint a capability token so `wscat` / `curl` can drive the LOCAL authenticated
 * fan-out app (`serve.ts`):
 *
 *   bun mint.ts <channel> <subscribe|publish>
 *
 * On the edge the `GET /` page is the issuer; locally this tiny CLI plays that role.
 * It signs with the SAME `resolveSecret()` `serve.ts` uses (real `PUBSUB_SECRET`, or
 * the dev key iff `PUBSUB_ALLOW_INSECURE=1`), so the token verifies against a
 * `serve.ts` started the same way. It prints just the token to stdout, so it drops
 * straight into a shell variable:
 *
 *   TOKEN=$(PUBSUB_ALLOW_INSECURE=1 bun mint.ts news subscribe)
 *   wscat -c "ws://127.0.0.1:3000/subscribe?channel=news&token=$TOKEN"
 */

import { mintChannelToken } from "@lesto/pubsub";

import { resolveSecret } from "./secret";

const [channel, mode] = process.argv.slice(2);

if (channel === undefined || channel.length === 0 || (mode !== "subscribe" && mode !== "publish")) {
  console.error("usage: bun mint.ts <channel> <subscribe|publish>");
  process.exit(1);
}

const token = await mintChannelToken(
  { channel, mode, exp: Date.now() + 3_600_000 },
  resolveSecret(),
);

console.log(token);
