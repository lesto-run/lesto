/**
 * @keel/mail — queued, transport-agnostic email built on @keel/queue.
 *
 *   const mailer = new Mailer({ queue, transport, render, defaultFrom: "hi@app.com" });
 *   mailer.define("welcome", ({ name, to }) => ({ to, subject: "Welcome", react: <Welcome name={name} /> }));
 *   mailer.send("welcome", { name: "Ada", to: "ada@example.com" });  // enqueued; a worker delivers it
 *
 * Two real transports ship:
 *   - `createSmtpTransport`  — Node-only (node:net/tls), STARTTLS + AUTH LOGIN.
 *   - `createFetchProviderTransport` — Workers-compatible (global fetch, no Node builtins).
 *
 * Delivery is **at-least-once**; every `RenderedEmail` carries a stable,
 * job-derived `messageId` so an idempotent transport can dedupe retries.
 */

export { Mailer, MailError, assertHeaders, assertNoInjection, messageIdFor } from "./mailer";
export type {
  Email,
  EmailRenderer,
  MailerOptions,
  MailErrorCode,
  MailTransport,
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
