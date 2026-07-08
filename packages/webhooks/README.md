# @lesto/webhooks

> HMAC-signed outbound webhooks (retried on @lesto/queue) + inbound verification.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/webhooks
```

```ts
import { Webhooks, verifyRequest } from "@lesto/webhooks";

// Sending — signed, queue-backed, retried. The raw secret never enters the queue
// (secretId is resolved to the real secret at delivery time).
const hooks = new Webhooks({ queue, secrets });
hooks.send("https://example.com/hook", "order.paid", { id: 42 }, { secretId });

// Receiving — verify over the RAW request bytes (c.req.rawBody), never a
// re-serialized body (re-stringifying breaks the signature).
const result = verifyRequest({ body: rawBody, headers: req.headers }, { secret });
if (!result.verified) reject(result.reason);
```

Signature verification is timing-safe and enforces a replay-tolerance window; the
signed `event` is extracted from the verified body.

[Docs](https://docs.lesto.run) · [Example](../../examples/webhooks)
