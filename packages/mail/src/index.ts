/**
 * @lesto/mail — queued, transport-agnostic email built on @lesto/queue.
 *
 *   const mailer = new Mailer({ queue, transport, render, defaultFrom: "hi@app.com" });
 *   const welcome = mailer.template("welcome", (p: { to: string; name: string }) =>
 *     ({ to: p.to, subject: "Welcome", react: <Welcome name={p.name} /> }));
 *   welcome.send({ to: "ada@example.com", name: "Ada" });  // typed; enqueued; a worker delivers it
 *
 * ## The render hook (bring your own renderer — e.g. react-email)
 *
 * `@lesto/mail` does NOT depend on React or react-email; it takes a `render`
 * function and stays dependency-light. Wire react-email in one line:
 *
 *   import { render } from "@react-email/render";
 *   new Mailer({ queue, transport, render });           // html only
 *
 * To get a plain-text alternative for free (better deliverability; text-only
 * clients), return `{ html, text }` from the hook — the mailer drops `text` into
 * the message and the transport emits `multipart/alternative`:
 *
 *   render: async (el) => ({
 *     html: await render(el),
 *     text: await render(el, { plainText: true }),
 *   })
 *
 * An explicit `email.text` always wins over the renderer's. See `examples/estate`
 * for real react-email templates + a shared base layout.
 *
 * ## Typed templates vs. open send
 *
 *   - `mailer.template(name, build)` returns a {@link MailTemplate} whose `.send`
 *     params are bound to the builder — a wrong shape is a compile error.
 *   - `mailer.send(name, params)` stays string-keyed on purpose: a name may not
 *     exist on this deploy yet (the parked unknown-mailer path), so dynamic
 *     dispatch cannot be type-checked. Reach for `template` when you can.
 *
 * Three real transports ship:
 *   - `createSmtpTransport`  — Node-only (node:net/tls), STARTTLS + AUTH LOGIN.
 *   - `createFetchProviderTransport` — Workers-compatible (global fetch, no Node builtins).
 *   - `createCloudflareEmailTransport` — Workers-only, drives the platform's
 *     `send_email` binding (Cloudflare Email Sending; no API keys).
 *
 * Delivery is **at-least-once**; every `RenderedEmail` carries a stable,
 * job-derived `messageId` so an idempotent transport can dedupe retries.
 *
 * ## Delivery observability
 *
 * Pass `onDelivered` / `onFailed` to watch deliveries without reading the queue:
 *
 *   new Mailer({ queue, transport,
 *     onDelivered: ({ mailerName, jobId, attempt }) => metrics.inc("mail.sent", { mailerName }),
 *     onFailed:    ({ mailerName, code }) => metrics.inc("mail.failed", { mailerName, code }),
 *   });
 *
 * Both payloads are PII-free — mailer name, job id, attempt, and (on failure) a
 * coded reason — so they are safe to forward to logs, counters, or an OTLP span.
 */

export {
  Mailer,
  MailError,
  assertHeaders,
  assertMessageId,
  assertNoInjection,
  failureCode,
  messageIdFor,
} from "./mailer";
export type {
  DeliveryEvent,
  DeliveryFailure,
  Email,
  EmailRenderer,
  MailerOptions,
  MailErrorCode,
  MailTemplate,
  MailTransport,
  OnDelivered,
  OnFailed,
  RenderedBody,
  RenderedEmail,
} from "./mailer";

export {
  createSmtpTransport,
  SmtpTransportError,
  nodeConnect,
  nodeUpgrade,
  loadNet,
  loadTls,
} from "./smtp";
export type {
  SmtpAuth,
  SmtpErrorCode,
  SmtpSocket,
  SmtpTransportConfig,
  NetModule,
  TlsModule,
} from "./smtp";

export { createFetchProviderTransport, FetchProviderError } from "./provider";
export type { FetchProviderConfig, FetchProviderErrorCode, ProviderRequestBody } from "./provider";

export { createCloudflareEmailTransport, CloudflareEmailError } from "./cloudflare";
export type {
  CloudflareEmailAddress,
  CloudflareEmailBinding,
  CloudflareEmailConfig,
  CloudflareEmailErrorCode,
  CloudflareEmailMessage,
} from "./cloudflare";
