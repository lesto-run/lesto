---
"@lesto/mail": patch
---

`createSmtpTransport().send()` now resolves a committed send PROMPTLY when the peer closes the connection, instead of waiting out the whole-dialogue deadline.

A relay that accepts the DATA body (250, committed per RFC 5321 §4.2) and then hangs up with a graceful FIN in the QUIT window emits no socket `error` — so with only an `error` listener the pending 221 reply-wait had nothing to settle it and sat idle until the whole-dialogue budget elapsed (correct outcome — the best-effort QUIT still swallowed the eventual timeout and resolved — but on a default 20s `timeoutMs` that is a needless ~20s stall holding the worker). `SmtpConnection` now also listens for socket `close` and settles the parked reply-wait the instant the peer FINs, using the same `MAIL_TRANSPORT_SMTP_CONNECTION` signal the RST path already produces: a post-commit close resolves at once, and a close mid-dialogue fails fast into a clean retry rather than burning the budget first. The RST path is unchanged (its `error` fires first and is kept), and a normal QUIT/221 close still tears down without touching this handler.
