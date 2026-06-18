/**
 * The client-error beacon receiver — `POST /__lesto/client-errors`.
 *
 * The browser-side island runtime (`@lesto/assets`'s synthesized client entry)
 * POSTs a small, PII-FREE JSON beacon when hydration goes wrong: a component that
 * failed to mount, an island whose module was missing (the classic deploy-skew
 * symptom — the HTML references a chunk a newer build no longer ships), and the
 * counts of each. This route is the server end of that beacon: it accepts the
 * payload leniently, normalizes it to a {@link ClientErrorEvent}, and forwards it
 * to an injectable {@link ClientErrorSink}.
 *
 * The sink is a SEAM, deliberately: this package logs the event (the default
 * sink), and the observability wave wires the same sink to OTLP — so an island
 * that broke for real users becomes an operator-visible signal, paired with the
 * server-side traces, without this route depending on the tracer.
 *
 * Two defenses keep an untrusted public endpoint safe:
 *
 *   - The body is BOUNDED: the runtime already caps the whole request body, but
 *     this route caps the *beacon* far tighter (a beacon is a handful of short
 *     strings), refusing an oversized payload with a coded 413 rather than
 *     feeding the sink an attacker-grown blob.
 *   - The shape is read LENIENTLY: the client owns the exact payload shape (it
 *     lives in another package and evolves with the client runtime), so this
 *     route never strict-validates it — it extracts the fields it understands and
 *     ignores the rest, so a client-version skew degrades to a partial event, not
 *     a 400. A body that is not even a JSON object is the one hard refusal (a 400).
 */

import type { Context } from "./handler-context";
import { WebError } from "./errors";
import type { Handler } from "./lesto";
import type { LestoResponse } from "./types";

/** The built-in path the client beacon POSTs to. */
export const CLIENT_ERRORS_ROUTE = "/__lesto/client-errors";

/**
 * The largest client-error beacon we accept, in bytes of its JSON form.
 *
 * A beacon is a few short component names and small integer counts; 16 KiB is
 * generous for that and still refuses an attacker trying to turn the endpoint
 * into a log-spam or memory-pressure vector. Smaller than the runtime's default
 * 1 MiB body cap on purpose — the beacon has no reason to be large.
 */
export const MAX_CLIENT_ERROR_BYTES = 16 * 1024;

/**
 * A normalized client-error beacon — PII-free by construction.
 *
 * Every field is optional because the client owns the payload shape and we read
 * it leniently: a beacon from a skewed client version may carry only some of
 * these. `failed`/`missing` are the island component names the hydrate runtime
 * reported (a name, never a value); `failedCount`/`missingCount` are the tallies
 * (which may exceed the listed names when the client sampled or truncated the
 * lists). Nothing here carries user data — only component identities and counts.
 */
export interface ClientErrorEvent {
  /** Component names whose island mount threw on the client. */
  readonly failed: readonly string[];

  /** Component names whose island module was missing (deploy-skew symptom). */
  readonly missing: readonly string[];

  /** How many islands failed to mount (may exceed `failed.length` if truncated). */
  readonly failedCount: number;

  /** How many island modules were missing (may exceed `missing.length`). */
  readonly missingCount: number;
}

/**
 * Where a normalized client-error beacon goes.
 *
 * Injected so a test asserts without a console, and so the observability wave can
 * wire it to OTLP. Defaults to {@link defaultClientErrorSink}: one structured
 * JSON line. A sink must not throw — this route swallows nothing on its behalf;
 * keep it total (log-and-return), like the access-log seam.
 */
export type ClientErrorSink = (event: ClientErrorEvent) => void;

/** A string array, with every non-string entry dropped — lenient by design. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.filter((entry): entry is string => typeof entry === "string");
}

/** A non-negative integer count, or `undefined` when the field is absent/garbage. */
function count(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;

  return Math.floor(value);
}

/**
 * Normalize a raw beacon body into a {@link ClientErrorEvent}, leniently.
 *
 * Reads only the fields it understands (`failed`, `missing`, and optional
 * `failedCount`/`missingCount`), dropping anything malformed. A count the client
 * omitted falls back to the length of the matching list, so a minimal beacon
 * (just the two arrays) still yields coherent tallies. Pure and exported so every
 * lenient-coercion branch is unit-testable.
 */
export function normalizeClientError(body: Record<string, unknown>): ClientErrorEvent {
  const failed = stringList(body["failed"]);
  const missing = stringList(body["missing"]);

  return {
    failed,
    missing,
    failedCount: count(body["failedCount"]) ?? failed.length,
    missingCount: count(body["missingCount"]) ?? missing.length,
  };
}

/**
 * The default sink: one structured JSON line per beacon.
 *
 * Structured so a log pipeline branches on `event`/counts rather than scraping a
 * string — the posture the access log and worker error sink take. PII-free: only
 * component names and counts are emitted, never any value the island carried.
 */
export function defaultClientErrorSink(event: ClientErrorEvent): void {
  console.error(
    JSON.stringify({
      level: "error",
      event: "client.island_error",
      failed: event.failed,
      missing: event.missing,
      failed_count: event.failedCount,
      missing_count: event.missingCount,
    }),
  );
}

/** True iff `body` is a plain JSON object (the only shape a beacon may take). */
function isObject(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

/**
 * The byte length of a value's JSON form, or `undefined` if it cannot serialize.
 *
 * Used to bound the beacon: the transport handed us the already-parsed body, so
 * to size it we re-serialize and measure UTF-8 bytes. A value that cannot
 * serialize (a circular structure the parser could never have produced, but
 * defended anyway) is treated as un-sizeable.
 */
function jsonByteLength(body: unknown): number | undefined {
  let serialized: string;

  try {
    serialized = JSON.stringify(body);
  } catch {
    return undefined;
  }

  // `undefined`/a function serializes to `undefined`; size it as zero — it is not
  // a real object and the `isObject` guard rejects it anyway.
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
}

/**
 * Build the `POST /__lesto/client-errors` handler over a {@link ClientErrorSink}.
 *
 * Bounds the body (a coded 413 over {@link MAX_CLIENT_ERROR_BYTES}), refuses a
 * non-object body (a 400 — the one strict check), and otherwise normalizes the
 * beacon and forwards it to `sink`, answering a bodiless 204 (the client only
 * needs to know it was received). Exported so the route can be registered as a
 * built-in and unit-tested directly.
 */
export function clientErrorsHandler(sink: ClientErrorSink): Handler {
  return (c: Context): LestoResponse => {
    const body = c.req.body;

    const size = jsonByteLength(body);

    if (size !== undefined && size > MAX_CLIENT_ERROR_BYTES) {
      // Coded so a caller/test branches on the code, not the status; the response
      // body stays terse — a beacon sender does not read prose.
      const error = new WebError(
        "WEB_CLIENT_ERROR_BODY_TOO_LARGE",
        `client-error beacon exceeds ${MAX_CLIENT_ERROR_BYTES} bytes`,
        { maxBytes: MAX_CLIENT_ERROR_BYTES, bytes: size },
      );

      return {
        status: 413,
        headers: { "content-type": "text/plain", "x-lesto-error": error.code },
        body: "Payload Too Large",
      };
    }

    if (!isObject(body)) {
      return { status: 400, headers: { "content-type": "text/plain" }, body: "Bad Request" };
    }

    sink(normalizeClientError(body));

    // A bodiless 204: the beacon was received; there is nothing for the client to
    // read back, and a body would only waste the round trip.
    return { status: 204, headers: {}, body: "" };
  };
}
