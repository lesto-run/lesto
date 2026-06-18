/**
 * W3C Trace Context `traceparent` — the propagation header, verbatim.
 *
 * One header carries a trace across a process boundary: an inbound request
 * adopts the upstream's trace id so the server span joins the same trace, and an
 * outbound call (a webhook, an edge sub-request) emits its own so the next hop
 * continues it. We implement the W3C format EXACTLY — never an invented one —
 * because that is the wire every collector, vendor, and sibling service already
 * speaks (the NIH boundary line operability-dx draws):
 *
 *   version "-" trace-id "-" parent-id "-" trace-flags
 *   00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 *
 *   - version    : 2 hex, the format version. We read only "00"; any other
 *                  version we DROP (a future format we cannot trust to parse).
 *   - trace-id   : 32 hex, the trace. All-zero is invalid (the spec's sentinel).
 *   - parent-id  : 16 hex, the caller's span — our span's PARENT. All-zero is
 *                  invalid.
 *   - trace-flags: 2 hex; bit 0 is "sampled". We carry it through unread (we
 *                  always export) but format it honestly.
 *
 * Volo's own ids are 32-hex traceIds and 32-hex spanIds; OTLP already truncates
 * a spanId to 16 hex on export (see `otlp.ts`), and traceparent's parent-id is
 * the same 16-hex span field — so {@link formatTraceparent} truncates a 32-hex
 * spanId to its first 16 hex, matching what the collector sees.
 */

/** The only `version` field we parse — a future version is dropped, not guessed. */
const SUPPORTED_VERSION = "00";

/** Default `trace-flags`: `01` = sampled. We always export, so we always set it. */
const SAMPLED_FLAGS = "01";

/** A 32-hex trace id (lowercase). */
const TRACE_ID = /^[0-9a-f]{32}$/;

/** A 16-hex parent (span) id (lowercase). */
const PARENT_ID = /^[0-9a-f]{16}$/;

/** A 2-hex flags byte (lowercase). */
const FLAGS = /^[0-9a-f]{2}$/;

/** The all-zero sentinel both id fields treat as invalid, per the spec. */
const isAllZero = (hex: string): boolean => /^0+$/.test(hex);

/** The parsed pieces of a valid `traceparent` an inbound request carried. */
export interface Traceparent {
  /** The 32-hex trace id this request belongs to — our root span adopts it. */
  readonly traceId: string;

  /** The 16-hex caller span id — the PARENT of the span we are about to mint. */
  readonly parentId: string;

  /** The 2-hex trace-flags byte, carried through verbatim (bit 0 = sampled). */
  readonly flags: string;
}

/**
 * Parse a `traceparent` header value, or `undefined` if it is absent/malformed.
 *
 * We are STRICT on inbound (the spec's posture for a received header): a header
 * we cannot fully trust is treated as no header at all, and the request roots a
 * fresh trace instead of joining a forged or garbled one. Rejected: an absent
 * value, the wrong field count, a non-"00" version, a non-hex or wrong-width id,
 * an all-zero (sentinel) trace or parent id, or a malformed flags byte. Lowercase
 * is required — the spec mandates lowercase hex, so an uppercase value is not a
 * valid traceparent.
 *
 * Pure and total so every reject branch is unit-testable without a socket.
 */
export function parseTraceparent(header: string | undefined): Traceparent | undefined {
  if (header === undefined) return undefined;

  const parts = header.split("-");

  // Exactly four fields: version, trace-id, parent-id, flags.
  if (parts.length !== 4) return undefined;

  const [version, traceId, parentId, flags] = parts as [string, string, string, string];

  // Only the version we know how to read; a future format we cannot trust.
  if (version !== SUPPORTED_VERSION) return undefined;

  if (!TRACE_ID.test(traceId) || isAllZero(traceId)) return undefined;

  if (!PARENT_ID.test(parentId) || isAllZero(parentId)) return undefined;

  if (!FLAGS.test(flags)) return undefined;

  return { traceId, parentId, flags };
}

/**
 * Format a `traceparent` header for an outbound hop from a trace + span id.
 *
 * `spanId` is the CURRENT span — it becomes the next hop's parent-id. A Volo
 * spanId is 32 hex; the traceparent parent-id field is 16 hex (the same field
 * OTLP truncates a spanId to), so we take its first 16 hex to match what the
 * collector records. `flags` defaults to `01` (sampled) — we always export. The
 * output is a spec-valid `00-…` header verbatim.
 *
 * The caller guarantees `traceId`/`spanId` are hex of at least the needed width
 * (they come from the tracer's id generator); we slice to the field widths the
 * format demands.
 */
export function formatTraceparent(traceId: string, spanId: string, flags = SAMPLED_FLAGS): string {
  return `${SUPPORTED_VERSION}-${traceId.slice(0, 32)}-${spanId.slice(0, 16)}-${flags}`;
}

/** The canonical header name, lowercase (the form node/fetch deliver and want). */
export const TRACEPARENT_HEADER = "traceparent";
