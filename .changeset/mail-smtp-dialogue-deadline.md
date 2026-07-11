---
"@lesto/mail": patch
---

`createSmtpTransport`'s `timeoutMs` is now a whole-dialogue budget, not a per-step timeout — closing a slow-server duplicate-send hole.

F15 added a per-read timeout meant to guarantee that "a stalled server fails the send BEFORE the visibility deadline — never a duplicate send." But `readLine` armed a **fresh** `setTimeout(…, timeoutMs)` on every call, and a send runs ~7 sequential reads (220 / EHLO / MAIL / RCPT / DATA / body / QUIT, more with `AUTH`) with no dialogue-wide bound. A server that answered just under `timeoutMs` on step after step — precisely the SMTP greylisting/tarpitting profile — accumulated unbounded total time while no single step ever tripped. The dialogue could drag past the queue's job-visibility window (30_000ms by default in `@lesto/queue`), the queue reclaimed the still-"running" job, and it re-delivered: the exact duplicate send F15 claimed to prevent. The old operator guidance ("keep `timeoutMs` below visibility") was insufficient and gave false confidence.

The fix fixes ONE deadline when the connection opens (`Date.now() + timeoutMs`, and deliberately not reset across the STARTTLS `rebind`) and caps every reply-wait to the time still remaining before it (`setTimeout(fail, Math.max(0, Math.min(timeoutMs, deadline - now)))`, firing on the next tick once the budget is spent). The whole dialogue can no longer outlast `timeoutMs`, so the send fails and releases the worker before the visibility deadline — a stall (or a slow-but-progressing tarpit) becomes a clean retry, never a duplicate.

**Behavior change.** `timeoutMs` now bounds the entire dialogue, not each step. A legitimately slow-but-progressing dialogue that used to survive step by step now fails once its aggregate deadline passes. That is intended: a failed send the queue retries is strictly safer than a duplicate send. If your relay is genuinely slow across many steps, raise `timeoutMs` — but keep it comfortably below the queue's visibility window. The timeout error code (`MAIL_TRANSPORT_SMTP_TIMEOUT`) and `details.timeoutMs` are unchanged.
