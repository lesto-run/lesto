/**
 * @keel/mail — queued, transport-agnostic email built on @keel/queue.
 *
 *   const mailer = new Mailer({ queue, transport, render, defaultFrom: "hi@app.com" });
 *   mailer.define("welcome", ({ name, to }) => ({ to, subject: "Welcome", react: <Welcome name={name} /> }));
 *   mailer.send("welcome", { name: "Ada", to: "ada@example.com" });  // enqueued; a worker delivers it
 */

export { Mailer, MailError } from "./mailer";
export type {
  Email,
  EmailRenderer,
  MailerOptions,
  MailErrorCode,
  MailTransport,
  RenderedEmail,
} from "./mailer";
