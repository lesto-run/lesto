/**
 * The read-only full-stack context ASSEMBLER for the in-preview AI surface
 * (ADR 0033 Phase 1, increment 4a).
 *
 * The overlay (Inc 1) and the bridge (Inc 3) both need a bounded, typed "context in"
 * payload — the little the model is allowed to see about the page in front of the
 * developer. `assembleContext` is the ONE place that shape is built, so the overlay and the
 * bridge can never disagree about what a turn carries. It is a pure, total transform: a raw
 * browser-observable {@link ContextSnapshot} in, a typed {@link AiContextPayload} out.
 *
 * Two properties matter:
 *   - It DEGRADES gracefully — the only required field is the route; a page with no
 *     `data-lesto-loc` handler location (ADR 0032 owns that attribute), no in-flight trace
 *     id, or no content collections assembles to route-only rather than failing.
 *   - It is a positive FIELD allowlist — the payload is constructed field by field from the
 *     four permitted keys, never spread from the snapshot, so a stray/unmodelled field on
 *     the raw snapshot can never ride out to the model. The type states the contract; the
 *     explicit construction enforces it at runtime.
 *
 * This assembler does NOT redact — {@link import("./ai-redact").redactContext} is the
 * separate stage every caller runs BEFORE the payload can leave the process (Inc 4b). Nor
 * does it fetch: the content collections are sourced upstream from the injected read-only
 * `list_content_collections` tool and handed in on the snapshot, so this stays pure and
 * synchronous.
 */

import type { AiContextPayload } from "./ai-redact";

/**
 * The raw, browser-observable inputs the overlay gathers before assembly. Only `route` is
 * required; each other field is present only when the page actually exposes it, and absent
 * fields degrade the payload rather than failing it.
 */
export interface ContextSnapshot {
  /** The current route/path the overlay was opened on (required). */
  readonly route: string;

  /** The handler `file:line` from the page's `data-lesto-loc` (ADR 0032), when present. */
  readonly handlerLocation?: string;

  /** The last request's trace id — the ID only, never span text (ADR 0031). */
  readonly traceId?: string;

  /** The content collection names, sourced upstream from `list_content_collections`. */
  readonly collections?: readonly string[];
}

/**
 * Assemble the bounded read-only context payload from a browser snapshot.
 *
 * Builds an {@link AiContextPayload} carrying ONLY the four permitted fields, each copied
 * explicitly (never spread) and each omitted when absent — so the result is a faithful,
 * minimal, allowlisted mirror of the snapshot, safe to hand to `redactContext` and then the
 * bridge. Pure and total: it neither reads the world nor throws.
 */
export function assembleContext(snapshot: ContextSnapshot): AiContextPayload {
  // Explicit field-by-field construction is the runtime guard: an unmodelled key on the raw
  // snapshot is never copied, so it can never leak into the payload the model sees.
  const payload: {
    route: string;
    handlerLocation?: string;
    traceId?: string;
    collections?: readonly string[];
  } = { route: snapshot.route };

  // Each optional is carried only when present — `exactOptionalPropertyTypes` forbids
  // stamping an explicit `undefined`, and route-only is the honest degraded shape.
  if (snapshot.handlerLocation !== undefined) payload.handlerLocation = snapshot.handlerLocation;

  if (snapshot.traceId !== undefined) payload.traceId = snapshot.traceId;

  if (snapshot.collections !== undefined) payload.collections = snapshot.collections;

  return payload;
}
