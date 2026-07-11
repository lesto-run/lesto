---
"@lesto/mail": patch
---

`createSmtpTransport().send()` no longer turns a post-commit QUIT hiccup — or a transient AUTH-step stall — into a duplicate or lost email.

**QUIT-window duplicate send.** The send gated overall success on `command("QUIT", 221)`. But once the server returns the 250 for the DATA body (the dot-terminated `\r\n.\r\n`), the message is COMMITTED per RFC 5321 §4.2 — the receiver has taken responsibility. If the server then withheld or slowed the 221 (a relay dropping the connection right after accepting is extremely common), the QUIT wait hit the whole-dialogue deadline and `send()` REJECTED — so the at-least-once queue re-delivered an already-accepted message, a guaranteed duplicate. Compounding it, the connection registered no `close` listener, so a post-250 connection close was caught only by the deadline (a slow reject → the same duplicate). The body-250 is now the point of success: QUIT is issued best-effort and any timeout / error / connection-close on the 221 is swallowed, so a post-commit hiccup — including a connection close — resolves the send rather than driving a re-send. A deadline that fires BEFORE the body-250 still rejects (nothing delivered → a clean retry), unchanged.

**AUTH-step timeout mis-coded as permanent.** `authenticate()` caught every error during the AUTH LOGIN / username / password steps and re-threw `MAIL_TRANSPORT_SMTP_AUTH`, so a transient stall (the deadline) during AUTH was reported as a credential failure — a queue that treats auth failures as permanent could DROP the job → a lost email. The catch now re-throws `SmtpTransportError`s coded `MAIL_TRANSPORT_SMTP_TIMEOUT` or `MAIL_TRANSPORT_SMTP_CONNECTION` UNCHANGED (retryable); only a genuine protocol / credential rejection (e.g. a 535) is wrapped as `MAIL_TRANSPORT_SMTP_AUTH`.

Both are behavior-preserving for the happy path and for real failures; only the misclassified transient/post-commit cases change, and always in the safe direction. Error codes and `details` are unchanged.
