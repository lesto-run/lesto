---
"@lesto/web": minor
"@lesto/runtime": minor
"@lesto/cloudflare": minor
"@lesto/webhooks": minor
"@lesto/kernel": minor
---

Byte-exact raw request bodies, so binary-webhook HMAC verification works by construction.

Previously the request body was decoded to a UTF-8 string before the app saw it, which lossily mangled any non-UTF-8 body (an image PUT, protobuf, a multipart upload) and made HMAC-over-bytes verification of a binary webhook impossible. The raw bytes are now preserved end-to-end and exposed as a `Uint8Array`.

- **`@lesto/web` / `@lesto/runtime` / `@lesto/cloudflare`**: `c.req.rawBytes` (a `Uint8Array`) is the exact undecoded request body on both the node server and the Cloudflare edge. `c.req.rawBody` (the UTF-8 string) is retained and unchanged — but it is byte-exact only for a UTF-8 body, so prefer `rawBytes` for signature verification.
- **`@lesto/webhooks`**: `sign`, `verify`, and `VerifyRequestInput.body` now accept `string | Uint8Array`, so `verifyRequest({ body: c.req.rawBytes, headers: c.req.headers }, { secret })` hashes the exact bytes the deliverer signed.
- **`@lesto/kernel`**: `App.handle`'s options carry `rawBytes` (via `@lesto/web`'s `HandleOptions`).

**Potentially breaking — external `SecretResolver` implementers.** `SecretResolverContext` extends `VerifyRequestInput`, so its `body` widens from `string` to `string | Uint8Array`. A resolver that read `ctx.body` as a string (e.g. `JSON.parse(ctx.body).tenant`) must narrow first:

```ts
const raw = typeof ctx.body === "string" ? ctx.body : new TextDecoder().decode(ctx.body);
```
