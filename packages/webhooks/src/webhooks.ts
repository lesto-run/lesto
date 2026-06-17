import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import { KeelError } from "@keel/errors";
import { permanentFailure } from "@keel/queue";
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
 *
 * Two invariants protect the system itself:
 *
 *   1. The signing secret is NEVER written into a queue row. We persist only a
 *      `secretId` reference and resolve the real secret at delivery time from an
 *      injected {@link SecretSource}. A leaked queue table thus leaks no secrets.
 *
 *   2. Every destination URL passes an SSRF guard before we connect: http(s)
 *      only, and the host must resolve to a public address — loopback,
 *      RFC1918, link-local (incl. the cloud metadata endpoint), and other
 *      reserved ranges are refused. The deliverer sets `redirect: "manual"` so a
 *      guarded public URL cannot 302 the request to a private endpoint after the
 *      guard ran — a 3xx is a delivery failure, never a followed hop.
 *
 *   3. Signatures bind a timestamp: we sign `${timestamp}.${body}` and ship the
 *      timestamp in an `x-keel-timestamp` header. `verify` checks the signature
 *      AND that the timestamp is within a caller-set tolerance, so a captured
 *      request replayed later fails — the replay window is the tolerance, not
 *      forever.
 *
 * RESIDUAL RISK — DNS-rebinding TOCTOU (documented, not closed): the guard
 * resolves the host and `fetch` resolves it again, so a hostile DNS server could
 * answer "public" to the guard and "private" to the fetch in the gap between.
 * IP-pinning the resolved address into the fetch (Host header preserved) would
 * close it, but that is not expressible through the injected {@link FetchLike} /
 * the Workers `fetch` we run on — neither lets a caller pin the connect IP while
 * keeping the Host. The mitigations we DO have: the guard blocks on *any*
 * resolved private address (so a name that resolves to both public and private
 * is refused outright), and `redirect: "manual"` removes the post-guard redirect
 * hop. A host that needs hard TOCTOU closure must inject a pinning `FetchLike`.
 */

const DELIVER_JOB = "keel.webhook.deliver";

export const EVENT_HEADER = "x-keel-event";
export const SIGNATURE_HEADER = "x-keel-signature";
export const TIMESTAMP_HEADER = "x-keel-timestamp";

/**
 * The W3C trace-context header. A webhook is a hop to another service, so it
 * carries `traceparent` outbound — the receiver's tracing joins the SAME trace
 * the request that enqueued the delivery belonged to. Verbatim W3C, never an
 * invented format (`@keel/observability` owns the parse/format; this package
 * only forwards the captured value, so it takes no tracing dependency).
 */
export const TRACEPARENT_HEADER = "traceparent";

/**
 * Default replay tolerance for {@link verify}: a signed request is accepted only
 * if its timestamp is within five minutes of now. Wide enough for clock skew and
 * queue latency, narrow enough that a captured request is useless soon after.
 */
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

export type WebhookErrorCode =
  | "WEBHOOK_DELIVERY_FAILED"
  | "WEBHOOK_SECRET_NOT_FOUND"
  | "WEBHOOK_URL_BLOCKED";

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

/** The signed payload when a timestamp binds the body against replay. */
function signedPayload(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

/** Options for a timestamp-bound {@link verify} that also defends against replay. */
export interface VerifyOptions {
  /**
   * The `x-keel-timestamp` value the sender shipped (epoch ms). When set, the
   * signature is checked over `${timestamp}.${body}` AND the timestamp must be
   * within {@link VerifyOptions.toleranceMs} of {@link VerifyOptions.now} — a
   * captured request replayed past the window fails.
   */
  readonly timestamp?: number;

  /** Replay tolerance in ms. Defaults to {@link DEFAULT_TOLERANCE_MS}. */
  readonly toleranceMs?: number;

  /** "Now" in epoch ms, injectable for tests. Defaults to `Date.now()`. */
  readonly now?: number;
}

/**
 * Constant-time check that `signature` is a valid HMAC of `body`.
 *
 * Pass `options.timestamp` to verify a timestamp-bound signature: the HMAC is
 * recomputed over `${timestamp}.${body}` (what the deliverer signs) and the
 * timestamp is additionally required to be within `toleranceMs` of `now`, so a
 * replayed capture outside the window is rejected even with a valid signature.
 * Omit `options` for the legacy body-only signature.
 */
export function verify(
  body: string,
  signature: string,
  secret: string,
  options: VerifyOptions = {},
): boolean {
  if (options.timestamp !== undefined) {
    const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS;
    const now = options.now ?? Date.now();

    // Outside the replay window: reject before any HMAC work.
    if (Math.abs(now - options.timestamp) > toleranceMs) return false;
  }

  const message = options.timestamp === undefined ? body : signedPayload(options.timestamp, body);

  const expected = Buffer.from(sign(message, secret));
  const provided = Buffer.from(signature);

  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export interface WebhookResponse {
  readonly ok: boolean;
  readonly status: number;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    /**
     * Always `"manual"` from the deliverer: a guarded public URL must not be
     * able to 3xx the request onward to a private endpoint after the SSRF guard
     * already ran. The real `fetch` honors this; an injected `FetchLike` should
     * too. Optional so older fetch stubs still type-check.
     */
    redirect?: "manual";
  },
) => Promise<WebhookResponse>;

/**
 * Resolves a `secretId` reference to the raw signing secret, at delivery time.
 *
 * The reference is what we persist; the secret itself lives wherever the host
 * keeps secrets (env, a vault, a `webhook_endpoints` table). Returning
 * `undefined` means "no such secret" — delivery then fails loud rather than
 * silently shipping an unsigned request.
 */
export type SecretSource = (secretId: string) => string | undefined | Promise<string | undefined>;

/**
 * Resolves a hostname to its IP addresses. Injected so tests need no network
 * and so a host can pin DNS. Defaults to the system resolver.
 */
export type Resolver = (hostname: string) => Promise<readonly string[]>;

/** The default {@link Resolver}: the operating system's DNS lookup. */
export const systemResolver: Resolver = async (hostname) => {
  const records = await lookup(hostname, { all: true });

  return records.map((record) => record.address);
};

/**
 * Captures the W3C `traceparent` for the request currently in flight, at SEND
 * time — so the value is the trace of the request that ENQUEUED the delivery, not
 * the unrelated worker poll that ships it later. Returns `undefined` when there
 * is no active trace (no request, no tracer). Injected so this package takes no
 * tracing dependency; the wiring site passes a closure over
 * `@keel/observability`'s `formatTraceparent` and the request context's span.
 */
export type TraceparentSource = () => string | undefined;

export interface WebhooksOptions {
  readonly queue: Queue;
  readonly fetch?: FetchLike;

  /** Resolves `secretId` -> secret at delivery time. Required to sign. */
  readonly secrets?: SecretSource;

  /** Hostname -> IPs, for the SSRF guard. Defaults to the system resolver. */
  readonly resolver?: Resolver;

  /** Allow/deny a destination URL. Defaults to {@link defaultUrlGuard}. */
  readonly urlGuard?: UrlGuard;

  /**
   * Captures the outbound `traceparent` at SEND time (see {@link TraceparentSource}).
   * Absent → no trace header is emitted (the untraced default). The captured
   * value rides the queue payload so the worker emits it at delivery time, joining
   * the receiver to the enqueuing request's trace.
   */
  readonly traceparent?: TraceparentSource;
}

interface DeliverPayload {
  readonly url: string;
  readonly event: string;
  readonly payload: JsonValue;
  /** A REFERENCE to the secret — never the secret itself. */
  readonly secretId?: string;
  /**
   * The W3C `traceparent` captured at send time, carried to delivery so the
   * outbound POST joins the enqueuing request's trace. Absent when no trace was
   * active. It is a propagation id, not a secret — safe to persist in the queue
   * row (unlike the signing secret, which is never written).
   */
  readonly traceparent?: string;
}

/**
 * Decide whether a destination URL is safe to connect to.
 *
 * The host may legitimately want internal delivery (a sidecar, a mesh), so the
 * verdict is injectable. The default below is safe-by-default: public http(s)
 * only. Returns `undefined` to allow, or a reason string to block.
 */
export type UrlGuard = (url: string, resolver: Resolver) => Promise<string | undefined>;

// IPv4 ranges that must never be reached from a user-controlled webhook URL.
// `address` is always a valid dotted quad (callers gate on isIP / a strict regex).
function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map((octet) => Number(octet));

  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved

  return false;
}

// Decode an IPv4-mapped IPv6 address into a dotted-quad string. Callers pass
// the *canonical* form (see `canonicalizeIPv6`), which always collapses
// ::ffff:a.b.c.d to its hex spelling ::ffff:HHHH:HHHH — so we only match hex.
function mappedIPv4(lower: string): string | undefined {
  // Two hex groups, each 16 bits; concatenated they are the 32-bit IPv4.
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);

  if (hex === null) return undefined;

  // A successful match guarantees both capture groups; the cast narrows away
  // the index-access `| undefined` that the regex shape already rules out.
  const high = Number.parseInt(hex[1] as string, 16);
  const low = Number.parseInt(hex[2] as string, 16);

  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

// Collapse an IPv6 literal to its canonical compressed form so range checks
// can't be evaded by an uncompressed spelling (e.g. "0:0:0:0:0:0:0:1" for
// loopback). A custom/injected resolver — or a hostile DNS server — may return
// a non-normalized address; `new URL` gives us node's canonical form for free.
function canonicalizeIPv6(address: string): string {
  try {
    return new URL(`http://[${address}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    // Not a parseable IPv6 literal; fall back to the input so the caller's
    // downstream checks (and the final "refuse the unknown" default) still run.
    return address;
  }
}

function isPrivateIPv6(address: string): boolean {
  const lower = canonicalizeIPv6(address).toLowerCase();

  if (lower === "::1") return true; // loopback
  if (lower === "::") return true; // unspecified
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7

  // IPv4-mapped (::ffff:a.b.c.d) — judge by the embedded IPv4.
  const embedded = mappedIPv4(lower);

  if (embedded !== undefined) return isPrivateIPv4(embedded);

  return false;
}

/** True iff `address` (a literal IP) is in a range we refuse to connect to. */
function isPrivateAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);

  // Not a recognizable IP literal — refuse.
  return true;
}

/**
 * The default SSRF guard. Allows only http(s) to a host whose every resolved
 * address is public. Blocking on *any* private address closes the obvious
 * DNS-rebinding bypass where a name resolves to both a public and a private IP.
 */
export const defaultUrlGuard: UrlGuard = async (url, resolver) => {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return "URL is not parseable.";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `scheme "${parsed.protocol}" is not allowed (http/https only).`;
  }

  // URL.hostname wraps IPv6 literals in brackets ("[::1]"); strip them so the
  // value is a bare address that node:net's isIP can recognize.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");

  // A literal IP is judged directly — never resolved.
  if (isIP(host) !== 0) {
    return isPrivateAddress(host) ? `host ${host} is a private/reserved address.` : undefined;
  }

  // Hostnames like "localhost" never reach DNS in practice; block by name too.
  if (host === "localhost") {
    return "host localhost is not allowed.";
  }

  const addresses = await resolver(host);

  if (addresses.length === 0) {
    return `host ${host} did not resolve.`;
  }

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return `host ${host} resolves to a private/reserved address (${address}).`;
    }
  }

  return undefined;
};

export class Webhooks {
  private readonly queue: Queue;

  private readonly fetchFn: FetchLike;

  private readonly secrets: SecretSource | undefined;

  private readonly resolver: Resolver;

  private readonly urlGuard: UrlGuard;

  private readonly traceparent: TraceparentSource | undefined;

  constructor(options: WebhooksOptions) {
    this.queue = options.queue;
    this.fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.secrets = options.secrets;
    this.resolver = options.resolver ?? systemResolver;
    this.urlGuard = options.urlGuard ?? defaultUrlGuard;
    this.traceparent = options.traceparent;

    this.queue.define(DELIVER_JOB, (payload) => this.deliver(payload as unknown as DeliverPayload));
  }

  /**
   * Queue a signed webhook for delivery. Returns the job id.
   *
   * `secretId` is a REFERENCE resolved at delivery time via the configured
   * {@link SecretSource} — the raw secret is never persisted in the queue.
   */
  async send(
    url: string,
    event: string,
    payload: JsonValue,
    options: { secretId?: string; maxAttempts?: number } = {},
  ): Promise<number> {
    // Capture the trace HERE, at enqueue time, while the request span is still in
    // flight — the worker that delivers later has no such context, so capturing at
    // delivery would lose the join. Absent (no tracer/request) leaves it off.
    const traceparent = this.traceparent?.();

    return this.queue.enqueue(
      DELIVER_JOB,
      {
        url,
        event,
        payload,
        ...(options.secretId === undefined ? {} : { secretId: options.secretId }),
        ...(traceparent === undefined ? {} : { traceparent }),
      },
      options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts },
    );
  }

  // Runs inside the worker: guard the URL, sign, POST, surface a non-2xx as failure.
  private async deliver(payload: DeliverPayload): Promise<void> {
    const blockedReason = await this.urlGuard(payload.url, this.resolver);

    if (blockedReason !== undefined) {
      // A blocked URL is a PERMANENT failure: an SSRF-refused or unroutable URL
      // resolves to the same private/reserved address on every attempt, so the
      // guard will refuse it identically forever. Mark it non-retryable
      // (`permanentFailure`) so the queue's `fail()` retires the job to `failed`
      // after THIS attempt instead of burning the full `maxAttempts` backoff
      // schedule on a delivery that can never succeed. The error stays a coded
      // `WEBHOOK_URL_BLOCKED` `WebhookError` — the marker is stamped in place, so
      // a caller can still branch on the code and `instanceof WebhookError`.
      throw permanentFailure(
        new WebhookError("WEBHOOK_URL_BLOCKED", `Refusing to deliver webhook: ${blockedReason}`, {
          url: payload.url,
        }),
      );
    }

    const body = JSON.stringify({ event: payload.event, data: payload.payload });
    const timestamp = Date.now();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [EVENT_HEADER]: payload.event,
      [TIMESTAMP_HEADER]: String(timestamp),
    };

    // Forward the trace captured at send time so the receiver's tracing joins the
    // enqueuing request's trace. Verbatim W3C — the captured string is whatever
    // `@keel/observability`'s `formatTraceparent` produced; this package never
    // synthesizes the format itself.
    if (payload.traceparent !== undefined) {
      headers[TRACEPARENT_HEADER] = payload.traceparent;
    }

    if (payload.secretId !== undefined) {
      // Sign `${timestamp}.${body}`, not the bare body, so the receiver's
      // `verify({ timestamp })` can reject a replayed capture outside tolerance.
      headers[SIGNATURE_HEADER] = sign(
        `${timestamp}.${body}`,
        await this.resolveSecret(payload.secretId),
      );
    }

    // `redirect: "manual"` is the SSRF closure: the guard validated THIS URL, so a
    // 3xx must not be followed to an unguarded (possibly private) endpoint. A
    // manual redirect surfaces as a non-ok 3xx response, which falls into the
    // delivery-failure path below — retried like any other failed attempt.
    const response = await this.fetchFn(payload.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });

    if (!response.ok) {
      const reason =
        response.status >= 300 && response.status < 400
          ? `redirected (${response.status}) — refusing to follow past the SSRF guard`
          : `returned ${response.status}`;

      throw new WebhookError("WEBHOOK_DELIVERY_FAILED", `Webhook to ${payload.url} ${reason}.`, {
        url: payload.url,
        status: response.status,
      });
    }
  }

  // Resolve a secretId to its secret, failing loud if the source can't.
  private async resolveSecret(secretId: string): Promise<string> {
    if (this.secrets === undefined) {
      throw new WebhookError(
        "WEBHOOK_SECRET_NOT_FOUND",
        "A secretId was given but no secrets source is configured.",
        { secretId },
      );
    }

    const secret = await this.secrets(secretId);

    if (secret === undefined) {
      throw new WebhookError(
        "WEBHOOK_SECRET_NOT_FOUND",
        `No secret is registered for secretId "${secretId}".`,
        { secretId },
      );
    }

    return secret;
  }
}
