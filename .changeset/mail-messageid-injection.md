---
"@lesto/mail": minor
---

Mail transports now validate `messageId` before splicing it into headers, and the SMTP `rebind` no longer leaks the pre-upgrade socket's data handler.

`RenderedEmail` is public surface, so a caller can hand a hand-built email straight to a transport. The `messageId` was previously spliced raw into the `Message-ID: <…>` header and the SMTP MIME boundary (`boundary="lesto-<messageId>"`) with no validation — a header/MIME injection vector. A new shared `assertMessageId()` (exported from `@lesto/mail`) bars CR/LF (classic header injection) **and** `"`/whitespace, which would otherwise break out of the quoted boundary or the angle-bracketed header without carrying any CR/LF. It runs at both splice edges (the SMTP transport and the provider idempotency-key header). Framework-minted `lesto-mail-<jobId>` ids are unaffected.

Separately, the SMTP `rebind` (the STARTTLS upgrade) now detaches only the pre-upgrade socket's `data` listener (`off("data", …)`) instead of leaving it attached, so post-upgrade bytes can no longer corrupt the shared reply buffer. It deliberately keeps the socket's `error`/`close` handlers — the pre-upgrade socket stays live as the TLS transport's underlying stream, and stripping its `error` handler would turn a later socket error into an uncaught exception (`removeAllListeners()` would have done exactly that).
