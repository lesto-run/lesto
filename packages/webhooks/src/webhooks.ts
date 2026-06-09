import { createHmac, timingSafeEqual } from "node:crypto";

import { KeelError } from "@keel/errors";
import type { JsonValue, Queue } from "@keel/queue";

/**
 * Webhooks — outbound delivery that can't be lost, inbound checks that can't be forged.
 *
 * Every send is a queue job: signed with HMAC-SHA256, POSTed, and — because it
 * rides @keel/queue — retried with backoff until the receiver returns 2xx. A
 * non-2xx response throws, which the queue treats as a failed attempt.
 *
 * `verify` is the mirror image for receiving: recompute the signature and
 * compare in constant time.
 */

const DELIVER_JOB = "keel.webhook.deliver";

export const EVENT_HEADER = "x-keel-event";
export const SIGNATURE_HEADER = "x-keel-signature";

export type WebhookErrorCode = "WEBHOOK_DELIVERY_FAILED";

export class WebhookError extends KeelError<WebhookErrorCode> {
  constructor(code: WebhookErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "WebhookError";
  }
}

/** HMAC-SHA256 of `body` under `secret`, hex-encoded. */
export function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Constant-time check that `signature` is a valid HMAC of `body`. */
export function verify(body: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(sign(body, secret));
  const provided = Buffer.from(signature);

  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export interface WebhookResponse {
  readonly ok: boolean;
  readonly status: number;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<WebhookResponse>;

export interface WebhooksOptions {
  readonly queue: Queue;
  readonly fetch?: FetchLike;
}

interface DeliverPayload {
  readonly url: string;
  readonly event: string;
  readonly payload: JsonValue;
  readonly secret?: string;
}

export class Webhooks {
  private readonly queue: Queue;

  private readonly fetchFn: FetchLike;

  constructor(options: WebhooksOptions) {
    this.queue = options.queue;
    this.fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchLike);

    this.queue.define(DELIVER_JOB, (payload) => this.deliver(payload as unknown as DeliverPayload));
  }

  /** Queue a signed webhook for delivery. Returns the job id. */
  send(
    url: string,
    event: string,
    payload: JsonValue,
    options: { secret?: string; maxAttempts?: number } = {},
  ): number {
    return this.queue.enqueue(
      DELIVER_JOB,
      { url, event, payload, ...(options.secret === undefined ? {} : { secret: options.secret }) },
      options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts },
    );
  }

  // Runs inside the worker: sign, POST, and surface a non-2xx as a failure.
  private async deliver(payload: DeliverPayload): Promise<void> {
    const body = JSON.stringify({ event: payload.event, data: payload.payload });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [EVENT_HEADER]: payload.event,
    };

    if (payload.secret !== undefined) {
      headers[SIGNATURE_HEADER] = sign(body, payload.secret);
    }

    const response = await this.fetchFn(payload.url, { method: "POST", headers, body });

    if (!response.ok) {
      throw new WebhookError(
        "WEBHOOK_DELIVERY_FAILED",
        `Webhook to ${payload.url} returned ${response.status}.`,
        {
          url: payload.url,
          status: response.status,
        },
      );
    }
  }
}
