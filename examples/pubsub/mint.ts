/**
 * Mint a capability token so `wscat` / `curl` can drive the LOCAL authenticated
 * fan-out app (`serve.ts`):
 *
 *   bun mint.ts <channel> <subscribe|publish>
 *
 * On the edge the `GET /` page is the issuer; locally this tiny CLI plays that role.
 * It signs with `PUBSUB_SECRET`, falling back to the SAME insecure dev default
 * `serve.ts` uses when it is unset, so the token verifies against a `serve.ts`
 * started the same way. It prints just the token to stdout, so it drops straight
 * into a shell variable:
 *
 *   TOKEN=$(bun mint.ts news subscribe)
 *   wscat -c "ws://127.0.0.1:3000/subscribe?channel=news&token=$TOKEN"
 */

import { mintChannelToken } from "@lesto/pubsub";

const [channel, mode] = process.argv.slice(2);

if (channel === undefined || channel.length === 0 || (mode !== "subscribe" && mode !== "publish")) {
  console.error("usage: bun mint.ts <channel> <subscribe|publish>");
  process.exit(1);
}

const secret = process.env.PUBSUB_SECRET ?? "dev-insecure-secret";
const token = await mintChannelToken({ channel, mode, exp: Date.now() + 3_600_000 }, secret);

console.log(token);
