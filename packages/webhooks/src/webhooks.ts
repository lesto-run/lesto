import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import { LestoError } from "@lesto/errors";
import { permanentFailure } from "@lesto/queue";
import type { JsonValue, Queue } from "@lesto/queue";

/**
 * Webhooks — outbound delivery that can't be lost, inbound checks that can't be forged.
 *
 * Every send is a queue job: signed with HMAC-SHA256, POSTed, and — because it
 * rides @lesto/queue — retried with backoff until the receiver returns 2xx. A
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
 *      timestamp in an `x-lesto-timestamp` header. `verify` checks the signature
 *      AND that the timestamp is within a caller-set tolerance, so a captured
 *      request replayed later fails — the replay window is the tolerance, not
 *      forever.
 *
 *   4. `verifyRequest` (multi-tenant form) distinguishes an unresolvable tenant
 *      from a bad signature by HOW it reports failure, not just what it reports:
 *      a {@link SecretResolver} that throws or returns no secret is a hard throw
 *      (`WEBHOOK_SECRET_UNRESOLVED`), while a resolved secret that fails the HMAC
 *      is a returned `{ verified: false, reason: "signature_mismatch" }` — never
 *      thrown. A caller who maps "threw" and "returned false" to DIFFERENT HTTP
 *      statuses (e.g. 404 for the former, 401 for the latter) turns that
 *      asymmetry into a tenant-existence oracle: an attacker with no valid
 *      secret can still learn which tenant ids exist by watching which status
 *      comes back. Map both outcomes to the SAME response (a flat 401, say) if
 *      that oracle would matter for your receiver.
 *
 * DNS-rebinding TOCTOU — closeable by opt-in: the default guard resolves the host
 * and the default `fetch` resolves it AGAIN, so a hostile DNS server could answer
 * "public" to the guard and "private" to the fetch in the gap between. The default
 * mitigations narrow it (the guard blocks on *any* resolved private address, so a
 * name that resolves to both public and private is refused outright; `redirect:
 * "manual"` removes the post-guard redirect hop), but they do not fully close it.
 *
 * `@lesto/webhooks` ships the pinning `FetchLike` the gap calls for:
 * {@link nodePinningFetch} (`pinning-fetch.ts`) resolves the host ONCE inside the
 * socket's own connect-time `lookup`, validates every resolved address with the
 * same {@link isPrivateAddress} rules, and lets the socket connect only to that
 * validated set — there is no second independent resolution to rebind, and TLS
 * still verifies against the hostname (SNI is unchanged; only the connect address
 * is pinned). Opt in on Node with `new Webhooks({ queue, fetch: nodePinningFetch() })`.
 * The default stays the portable global `fetch` so the Workers edge build is
 * unaffected.
 */

const DELIVER_JOB = "lesto.webhook.deliver";

export const EVENT_HEADER = "x-lesto-event";
export const SIGNATURE_HEADER = "x-lesto-signature";
export const TIMESTAMP_HEADER = "x-lesto-timestamp";

/**
 * The W3C trace-context header. A webhook is a hop to another service, so it
 * carries `traceparent` outbound — the receiver's tracing joins the SAME trace
 * the request that enqueued the delivery belonged to. Verbatim W3C, never an
 * invented format (`@lesto/observability` owns the parse/format; this package
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
  | "WEBHOOK_DELIVERY_TIMEOUT"
  | "WEBHOOK_SECRET_NOT_FOUND"
  | "WEBHOOK_SECRET_UNRESOLVED"
  | "WEBHOOK_URL_BLOCKED";

export class WebhookError extends LestoError<WebhookErrorCode> {
  constructor(code: WebhookErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "WebhookError";
  }
}

/**
 * HMAC-SHA256 of `body` under `secret`, hex-encoded.
 *
 * `body` accepts a `string` (the original, still-dominant case: JSON, form
 * data, any UTF-8 payload) OR the raw `Uint8Array` a transport captured before
 * any decode — node's `Hmac.update` hashes either as-is, so a `Uint8Array` is
 * hashed byte-for-byte with NO UTF-8 round trip. That round trip is what makes
 * a `string`-typed path lossy for a binary body (an image, a protobuf, a
 * multipart upload): decoding non-UTF-8 bytes to a JS string and re-encoding
 * them is not guaranteed to reproduce the original bytes, so a binary
 * webhook's HMAC MUST be computed over the raw bytes (e.g. `c.req.rawBytes`),
 * never a decoded string.
 */
export function sign(body: string | Uint8Array, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * The signed payload when a timestamp binds the body against replay:
 * `${timestamp}.` followed by the body, byte-for-byte.
 *
 * A `string` body is concatenated as before — unchanged output for every
 * existing (string-bodied) caller. A `Uint8Array` body is NOT decoded to a
 * string and re-concatenated (that would corrupt a non-UTF-8 body); instead
 * the ASCII `${timestamp}.` prefix bytes are prepended directly to the raw
 * body bytes, so the result hashes to the same signature a receiver computes
 * over `${timestamp}.` + the exact wire bytes.
 */
function signedPayload(timestamp: number, body: string | Uint8Array): string | Uint8Array {
  if (typeof body === "string") {
    return `${timestamp}.${body}`;
  }

  const prefix = Buffer.from(`${timestamp}.`, "utf8");
  const combined = new Uint8Array(prefix.length + body.length);

  combined.set(prefix, 0);
  combined.set(body, prefix.length);

  return combined;
}

/** Options for a timestamp-bound {@link verify} that also defends against replay. */
export interface VerifyOptions {
  /**
   * The `x-lesto-timestamp` value the sender shipped (epoch ms). When set, the
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
 *
 * `body` accepts a `string` or the raw `Uint8Array` a transport captured — see
 * {@link sign} for why the byte-exact arm matters for a binary body.
 */
export function verify(
  body: string | Uint8Array,
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

/** Why {@link verifyRequest} returned `verified: false`. */
export type VerifyFailureReason =
  | "missing_signature"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "stale_timestamp"
  | "signature_mismatch";

/** The inbound request material {@link verifyRequest} needs: raw body + headers. */
export interface VerifyRequestInput {
  /**
   * The exact undecoded request bytes — verification hashes THIS, never a
   * re-serialized body.
   *
   * A `string` (e.g. `c.req.rawBody`) works for any UTF-8 body, the original
   * and still-dominant case. Pass the raw `Uint8Array` (e.g. `c.req.rawBytes`)
   * for a byte-exact check of a body that may not be valid UTF-8 (an image, a
   * protobuf, a multipart upload) — a `string` re-encode of such a body is not
   * guaranteed byte-identical to what was sent, so the HMAC would not match.
   */
  readonly body: string | Uint8Array;
  /** Lowercase header map (as `@lesto/web`'s `c.req.headers` provides). */
  readonly headers: Record<string, string | undefined>;
}

/**
 * The material a {@link SecretResolver} sees to pick the per-request secret: the
 * raw request (body + headers) plus the sender's already-parsed timestamp. A
 * multi-tenant receiver reads a tenant/source identifier from the headers (or
 * the body) and returns THAT tenant's signing secret.
 *
 * Deliberately excludes the signature. A resolver's job is SELECTION — "whose
 * secret is this?" — never verification: the signature is checked afterward, by
 * {@link verifyRequest} itself, over the raw body, against whatever secret the
 * resolver returns. The signature has no legitimate role in choosing a secret,
 * so it is not reachable here at all — that forecloses a resolver that
 * compares or logs the exact value under check, intentionally or by accident.
 *
 * Reading the body here only SELECTS which secret to check against — a forger
 * who names a tenant whose secret they do not hold simply fails the
 * constant-time HMAC check afterward. The identifier is untrusted until the
 * HMAC passes.
 */
export interface SecretResolverContext extends VerifyRequestInput {
  /** The parsed `x-lesto-timestamp` (epoch ms), already inside the replay window. */
  readonly timestamp: number;
}

/**
 * Resolves the signing secret PER REQUEST, so ONE receiver can verify many
 * tenants/sources each with a distinct secret. Return the secret as a `string`
 * (sync) or a `Promise<string>` (an async lookup — a DB row, a vault fetch).
 *
 * Fails CLOSED: if the resolver throws OR yields a falsy secret, {@link
 * verifyRequest} rejects with a `WEBHOOK_SECRET_UNRESOLVED` {@link WebhookError}
 * — an unresolved secret is a hard error, NEVER a silent "skip verification".
 */
export type SecretResolver = (ctx: SecretResolverContext) => string | Promise<string>;

/** Options for {@link verifyRequest}. */
export interface VerifyRequestOptions {
  /**
   * The signing secret, known out-of-band by the receiver (the deliverer sends
   * no endpoint id). EITHER a static `string` — the single-secret receiver, the
   * original behavior — OR a {@link SecretResolver} `(ctx) => string |
   * Promise<string>` that picks the secret per request, so one endpoint can
   * verify many tenants/sources each with its own secret.
   *
   * A static string keeps {@link verifyRequest} synchronous; a resolver makes it
   * return a `Promise` (the resolver may be async).
   */
  readonly secret: string | SecretResolver;
  /** Replay tolerance in ms. Defaults to {@link DEFAULT_TOLERANCE_MS}. */
  readonly toleranceMs?: number;
  /** "Now" in epoch ms, injectable for tests. Defaults to `Date.now()`. */
  readonly now?: number;
}

/** The verdict from {@link verifyRequest}. */
export interface VerifyRequestResult {
  readonly verified: boolean;
  /** The `event` from the SIGNED `{event,data}` body — present only when verified AND parseable. */
  readonly event?: string;
  /** Present only when `verified` is `false`. */
  readonly reason?: VerifyFailureReason;
}

/** The validated request material {@link verifyRequest} carries past its pre-checks. */
interface VerifyPrecheckOk {
  readonly signature: string;
  readonly timestamp: number;
  readonly now: number;
  readonly toleranceMs: number;
}

/**
 * Either the secret-independent facts a verification needs (`ok: true`) or an
 * early failure verdict — a discriminated result so the secret-dependent tail
 * never runs against a request we already know is malformed or stale.
 */
type VerifyPrecheck =
  | { readonly ok: false; readonly result: VerifyRequestResult }
  | ({ readonly ok: true } & VerifyPrecheckOk);

/**
 * The cheap, secret-INDEPENDENT pre-checks: header presence, timestamp shape,
 * and the replay window. Runs BEFORE any secret is resolved, so an obviously-bad
 * request (missing header, malformed/stale timestamp) never invokes a
 * {@link SecretResolver} — no wasted lookup, no resolver side effects on junk.
 */
function precheckVerifyRequest(
  input: VerifyRequestInput,
  options: VerifyRequestOptions,
): VerifyPrecheck {
  const signature = input.headers[SIGNATURE_HEADER];

  if (signature === undefined) {
    return { ok: false, result: { verified: false, reason: "missing_signature" } };
  }

  const timestampHeader = input.headers[TIMESTAMP_HEADER];

  if (timestampHeader === undefined) {
    return { ok: false, result: { verified: false, reason: "missing_timestamp" } };
  }

  const timestamp = Number(timestampHeader);

  if (Number.isNaN(timestamp) || !Number.isFinite(timestamp)) {
    return { ok: false, result: { verified: false, reason: "malformed_timestamp" } };
  }

  const now = options.now ?? Date.now();
  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS;

  // Explicit staleness check: `verify` folds "stale" into a bare `false`, which
  // would be indistinguishable from a forged signature. Checking it here first
  // lets a caller tell replay-window expiry apart from tampering.
  if (Math.abs(now - timestamp) > toleranceMs) {
    return { ok: false, result: { verified: false, reason: "stale_timestamp" } };
  }

  return { ok: true, signature, timestamp, now, toleranceMs };
}

/**
 * The secret-DEPENDENT tail: the constant-time HMAC check over the RAW body
 * (never a re-serialized one), then — on success — `event` pulled from the
 * SIGNED `{event,data}` body (never the unsigned `x-lesto-event` header, which a
 * forger can set to anything). Shared verbatim by the static-secret and
 * resolver paths so both verify identically.
 */
function completeVerifyRequest(
  input: VerifyRequestInput,
  pre: VerifyPrecheckOk,
  secret: string,
): VerifyRequestResult {
  const ok = verify(input.body, pre.signature, secret, {
    timestamp: pre.timestamp,
    toleranceMs: pre.toleranceMs,
    now: pre.now,
  });

  if (!ok) {
    return { verified: false, reason: "signature_mismatch" };
  }

  let event: string | undefined;

  try {
    // `JSON.parse` takes a string; a `Uint8Array` body is decoded here ONLY for
    // this best-effort `event` extraction — the HMAC above already ran over the
    // raw bytes, so this decode cannot affect verification, only whether we can
    // additionally report which event was signed.
    const bodyText =
      typeof input.body === "string" ? input.body : Buffer.from(input.body).toString("utf8");
    const parsed: unknown = JSON.parse(bodyText);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { event?: unknown }).event === "string"
    ) {
      event = (parsed as { event: string }).event;
    }
  } catch {
    // A signed body need not be JSON (or need not be `{event,...}`) — the
    // signature already proved authenticity; a non-JSON/non-shaped body just
    // means no `event` to report, not a verification failure.
  }

  return { verified: true, ...(event === undefined ? {} : { event }) };
}

/**
 * Inbound counterpart to {@link Webhooks.send}: given the raw request body and
 * headers, checks the `x-lesto-signature`/`x-lesto-timestamp` pair and — on
 * success — extracts `event` from the signed `{event,data}` body (never the
 * unsigned `x-lesto-event` header, which a forger can set to anything).
 *
 * Delegates the actual HMAC/timing-safe comparison to {@link verify}; this
 * helper only resolves headers, distinguishes *why* a request failed (a bare
 * `false` from `verify` can't tell "stale" from "forged"), and safely parses
 * the body JSON.
 *
 * The signing secret is EITHER a static `string` — synchronous, the original
 * single-secret behavior, unchanged — OR a {@link SecretResolver} for the
 * multi-tenant case, where one receiver verifies many sources each with its own
 * secret. A resolver makes this return a `Promise<VerifyRequestResult>` and
 * fails CLOSED (`WEBHOOK_SECRET_UNRESOLVED`) if it throws or yields a falsy
 * secret — an unresolved secret never quietly passes verification.
 */
export function verifyRequest(
  input: VerifyRequestInput,
  options: Omit<VerifyRequestOptions, "secret"> & { readonly secret: string },
): VerifyRequestResult;
export function verifyRequest(
  input: VerifyRequestInput,
  options: Omit<VerifyRequestOptions, "secret"> & { readonly secret: SecretResolver },
): Promise<VerifyRequestResult>;
export function verifyRequest(
  input: VerifyRequestInput,
  options: VerifyRequestOptions,
): VerifyRequestResult | Promise<VerifyRequestResult> {
  const pre = precheckVerifyRequest(input, options);

  // Static secret: fully synchronous — byte-for-byte the original path, so every
  // existing caller compiles and behaves identically.
  if (typeof options.secret === "string") {
    return pre.ok ? completeVerifyRequest(input, pre, options.secret) : pre.result;
  }

  // Per-request resolver (multi-tenant): async, because the resolver may be. The
  // pre-checks already ran synchronously above; a resolver is invoked ONLY for a
  // request that has cleared them, and the whole path fails CLOSED.
  const resolveSecret = options.secret;

  return (async (): Promise<VerifyRequestResult> => {
    if (!pre.ok) return pre.result;

    let secret: string;

    try {
      secret = await resolveSecret({
        body: input.body,
        headers: input.headers,
        timestamp: pre.timestamp,
      });
    } catch (cause) {
      // Fail CLOSED: a resolver that throws (bad tenant id, lookup failure) is a
      // hard error, not a pass. Preserve the original in `cause` for debugging.
      throw new WebhookError(
        "WEBHOOK_SECRET_UNRESOLVED",
        "The per-request secret resolver threw while resolving the signing secret.",
        { cause },
      );
    }

    // Fail CLOSED on an absent/empty secret. The resolver's type says `string`,
    // but a JS caller can still hand back "" / undefined — treat any falsy value
    // as "no secret for this tenant" rather than verifying against nothing.
    if (typeof secret !== "string" || secret.length === 0) {
      throw new WebhookError(
        "WEBHOOK_SECRET_UNRESOLVED",
        "The per-request secret resolver returned no signing secret.",
      );
    }

    return completeVerifyRequest(input, pre, secret);
  })();
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

    /**
     * The per-delivery deadline as an abort signal (see
     * {@link WebhooksOptions.deliveryTimeoutMs}). The deliverer ALWAYS sets it so
     * a slow or hostile receiver cannot pin a queue worker; the real `fetch` and
     * the Node pinning transport both honor it, destroying the socket on abort.
     * Optional so older fetch stubs still type-check.
     */
    signal?: AbortSignal;
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
 * `@lesto/observability`'s `formatTraceparent` and the request context's span.
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

  /**
   * Abort — and so fail, then retry — an outbound delivery if the POST does not
   * complete within this many ms. A tenant-provided URL that completes the
   * TCP/TLS handshake and then never responds (or trickles bytes) would otherwise
   * hold a queue worker's `await` open until the OS-level timeout (minutes),
   * letting one slow or hostile receiver starve the shared delivery pool — a
   * denial-of-service on the webhook subsystem. Surfaces as a retryable
   * {@link WebhookError} coded `WEBHOOK_DELIVERY_TIMEOUT`.
   *
   * Defaults to 10_000. It MUST sit well under the queue's job-visibility window
   * (30_000ms in `@lesto/queue`): the delivery has to fail and release the worker
   * BEFORE the visibility deadline lapses, or the queue reclaims the still-
   * "running" job and delivers it a SECOND time.
   */
  readonly deliveryTimeoutMs?: number;
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

/**
 * True iff `address` (a literal IP) is in a range we refuse to connect to.
 *
 * Exported so the IP-pinning {@link FetchLike} (`pinning-fetch.ts`) validates the
 * connect-time address against the SAME allow/deny rules as {@link defaultUrlGuard}
 * — one source of truth for "is this address public".
 */
export function isPrivateAddress(address: string): boolean {
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

/**
 * Default per-delivery deadline: ten seconds, comfortably under `@lesto/queue`'s
 * 30s job-visibility window so a delivery fails and releases its worker before the
 * queue would reclaim the still-"running" job and deliver it twice. See
 * {@link WebhooksOptions.deliveryTimeoutMs}.
 */
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

export class Webhooks {
  private readonly queue: Queue;

  private readonly fetchFn: FetchLike;

  private readonly secrets: SecretSource | undefined;

  private readonly resolver: Resolver;

  private readonly urlGuard: UrlGuard;

  private readonly traceparent: TraceparentSource | undefined;

  private readonly deliveryTimeoutMs: number;

  constructor(options: WebhooksOptions) {
    this.queue = options.queue;
    this.fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.secrets = options.secrets;
    this.resolver = options.resolver ?? systemResolver;
    this.urlGuard = options.urlGuard ?? defaultUrlGuard;
    this.traceparent = options.traceparent;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;

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
    // `@lesto/observability`'s `formatTraceparent` produced; this package never
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
    //
    // `signal` bounds the WHOLE POST. Without it a receiver that completes the
    // handshake and then stalls would hold this worker's `await` open until the
    // OS TCP timeout (minutes) — long past the queue's visibility window — so one
    // slow or hostile tenant could starve the shared delivery pool. The deadline
    // aborts the request instead, turning a stall into a clean retryable failure.
    let response: WebhookResponse;

    try {
      response = await this.fetchFn(payload.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.deliveryTimeoutMs),
      });
    } catch (cause) {
      // A coded WebhookError from the transport itself — e.g. the pinning fetch
      // refusing a connect-time DNS rebind with WEBHOOK_URL_BLOCKED — is already
      // the right verdict; pass it through untouched.
      if (cause instanceof WebhookError) throw cause;

      // Everything else is the deadline firing (or a transport-level error). Map
      // it by STRUCTURE, never by exception NAME: `AbortSignal.timeout` rejects
      // with a `DOMException` named "TimeoutError" on the global-fetch/undici/
      // workerd path but with "AbortError" on the Node `http.request` (pinning)
      // path, so keying the catch on `name === "AbortError"` would MISS the real
      // production timeout. A distinct, retryable code keeps "slow" legible apart
      // from "errored" (callers branch on `code`) and is retried like any other
      // failed attempt — permanence is marker-based, and this failure carries no
      // `permanentFailure` marker.
      throw new WebhookError(
        "WEBHOOK_DELIVERY_TIMEOUT",
        `Webhook delivery to ${payload.url} did not complete within ${this.deliveryTimeoutMs}ms.`,
        { url: payload.url, timeoutMs: this.deliveryTimeoutMs, cause },
      );
    }

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
