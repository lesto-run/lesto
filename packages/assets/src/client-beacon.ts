/**
 * The client error beacon (ADR 0011, the "`onRecoverableError`/`onMountError`
 * sinks promoted to a dev overlay" promise; `docs/plans/ui-client.md` item 5).
 *
 * The synthesized client entry ({@link synthesizeEntry}) wires the island
 * hydration sinks here so a production deploy reports island-level breakage —
 * a deploy-skew unknown component, a mount that threw, a hydration mismatch —
 * to an operator without a human ever opening a console. In dev the same
 * signals paint an overlay instead of crossing the network.
 *
 * Two hard rules shape every line below:
 *
 *   - **Bounded sampling.** A site under load must not DDoS its own error route,
 *     so each report is gated by a configurable rate (default a conservative
 *     {@link DEFAULT_SAMPLE_RATE}). The gate is `random() < rate`, with `random`
 *     injected so the rate is provable in a test rather than flaky.
 *   - **No PII, ever.** The payload carries only *shapes the framework itself
 *     authored* — an island's registered name (a code identifier), an error's
 *     CLASS or coded `KeelError.code`, and COUNTS. Never `error.message` (it can
 *     interpolate user data), never a component stack, never a data bind value.
 *
 * The runtime is a single self-contained function ({@link reportClientErrors})
 * so the synthesized entry can inline it via `.toString()` — the browser bundle
 * carries no `@keel/assets` import, yet the code that ships is the exact code
 * this file's tests exercise (no string-vs-source drift).
 */

/** Where the beacon POSTs — the receiving route lives in `@keel/web` (core-runtime). */
export const BEACON_PATH = "/__keel/client-errors";

/**
 * The default sampling rate: 10% of reporting sessions actually POST.
 *
 * Conservative on purpose — a beacon exists to *notice* a class of breakage, not
 * to count every instance, and an unsampled beacon turns one bad deploy into a
 * self-inflicted request flood. An operator who wants more signal raises it.
 */
export const DEFAULT_SAMPLE_RATE = 0.1;

/** The kind of client-side fault one beacon event describes. */
export type BeaconEventKind =
  /** A summary of one `hydrateDocumentIslands` pass: what failed / went missing. */
  | "hydrate"
  /** One island's mount threw (or named an unknown component on a stale page). */
  | "mount-error"
  /** React recovered a hydration mismatch (the mount survived; the DOM was patched). */
  | "recoverable-error";

/**
 * One PII-free beacon event.
 *
 * Every field is either a framework-authored code identifier or a count — there
 * is deliberately no slot for free text, so a careless future edit cannot smuggle
 * a user string through. `component`/`errorClass` are optional because the
 * hydrate-summary event names neither.
 */
export interface BeaconEvent {
  readonly kind: BeaconEventKind;

  /** The island's registered name (a code identifier), when the event is about one island. */
  readonly component?: string;

  /** The error's coded `KeelError.code` or its constructor name — never its message. */
  readonly errorClass?: string;

  /** Count of islands whose mount failed (hydrate-summary events only). */
  readonly failed?: number;

  /** Count of islands whose shell was absent (hydrate-summary events only). */
  readonly missing?: number;
}

/** The exact JSON body the beacon POSTs to {@link BEACON_PATH}. */
export interface BeaconPayload {
  /** Schema version, so the receiver (and operability-dx's OTLP wire) can evolve. */
  readonly v: 1;

  readonly events: readonly BeaconEvent[];
}

/** The `HydrationResult` shape the beacon reads (a structural subset of `@keel/ui`'s). */
interface HydrationOutcome {
  readonly failed: readonly string[];
  readonly missing: readonly string[];
}

/** Knobs the synthesized entry passes through; all have safe browser defaults. */
export interface BeaconOptions {
  /** Fraction of sessions that POST, in `[0, 1]`. Defaults to {@link DEFAULT_SAMPLE_RATE}. */
  readonly sampleRate?: number;

  /** `true` in `keel dev`: paint the overlay, POST nothing. Defaults to `false`. */
  readonly dev?: boolean;

  /** Sampling source, injected for tests. Defaults to `Math.random`. */
  readonly random?: () => number;

  /** The POST transport, injected for tests. Defaults to `fetch`. */
  readonly send?: (path: string, payload: BeaconPayload) => void;

  /** The dev sink, injected for tests. Defaults to a DOM overlay. */
  readonly overlay?: (payload: BeaconPayload) => void;
}

/**
 * Distill any thrown value to a PII-free class string.
 *
 * A `KeelError` carries a stable `code` we prefer (`UI_ISLAND_UNKNOWN_COMPONENT`
 * tells an operator "deploy skew" at a glance). Anything else collapses to its
 * constructor name (`TypeError`, `RangeError`). We NEVER read `.message` — that
 * is where interpolated user data hides.
 */
export function errorClass(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;

    // A `KeelError`-style code is a SCREAMING_SNAKE identifier — never user data.
    if (typeof code === "string" && code.length > 0) return code;

    const ctor = (error as { constructor?: { name?: unknown } }).constructor;

    if (ctor && typeof ctor.name === "string" && ctor.name.length > 0) return ctor.name;
  }

  // A thrown primitive (string/number) has no class; report only its typeof, so
  // even `throw "secret-token"` cannot leak — we send "string", never the value.
  return typeof error;
}

/**
 * Build the hydrate-summary event from one pass's result.
 *
 * Carries the failed/missing COUNTS plus the failed islands' registered NAMES
 * (code identifiers, the actionable signal: "the `Account` island is dark on
 * production"). Island *ids* — tree paths that could in theory echo a route —
 * are deliberately omitted; the name is enough to find the bug and is guaranteed
 * author-chosen, not user-derived.
 */
export function hydrateEvent(result: HydrationOutcome): BeaconEvent {
  return {
    kind: "hydrate",
    failed: result.failed.length,
    missing: result.missing.length,
  };
}

/**
 * Decide whether this session reports, gated by the bounded rate.
 *
 * `rate <= 0` never reports; `rate >= 1` always does; in between it is a single
 * `random() < rate` draw. Clamped so a misconfigured rate cannot become an
 * always-on flood or a negative no-op surprise.
 */
export function shouldSample(rate: number, random: () => number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;

  return random() < rate;
}

/** The default browser transport: a fire-and-forget POST that never rejects the page. */
export function defaultSend(path: string, payload: BeaconPayload): void {
  // `keepalive` lets the POST outlive an unload (the report still lands on a
  // navigation away); a rejected fetch is swallowed — a dead beacon must never
  // become a second client error.
  void fetch(path, {
    method: "POST",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

/**
 * The default dev overlay — the ADR-0011-promised "sinks promoted to a dev
 * overlay". A fixed, dismissible banner naming each event's kind/component/class,
 * so a hydration fault is loud in development instead of a buried console line.
 *
 * It renders only counts and code identifiers — the same PII-free fields the
 * POST would carry — so dev and prod never disagree about what is safe to show.
 */
export function defaultOverlay(payload: BeaconPayload): void {
  const lines = payload.events.map((event) => {
    const where = event.component ? ` ${event.component}` : "";
    const why = event.errorClass ? `: ${event.errorClass}` : "";
    const counts =
      event.kind === "hydrate"
        ? ` (failed ${event.failed ?? 0}, missing ${event.missing ?? 0})`
        : "";

    return `[keel] ${event.kind}${where}${why}${counts}`;
  });

  const box = document.createElement("div");
  box.setAttribute("data-keel-error-overlay", "");
  box.style.cssText =
    "position:fixed;bottom:8px;right:8px;z-index:2147483647;max-width:32rem;" +
    "padding:8px 12px;background:#7f1d1d;color:#fff;font:12px/1.5 ui-monospace,monospace;" +
    "border-radius:6px;white-space:pre-wrap;cursor:pointer";
  box.textContent = lines.join("\n");

  // Click to dismiss — the overlay is a nudge, never a wall.
  box.addEventListener("click", () => box.remove());

  document.body.appendChild(box);
}

/**
 * Wire the island hydration sinks to the beacon and return the
 * `{ onMountError, onRecoverableError, report }` an entry hands to
 * `hydrateDocumentIslands`.
 *
 * Each sink builds ONE PII-free {@link BeaconEvent} and pushes it through
 * {@link emit}; `report` flushes the hydrate-summary after the pass returns.
 * Every emit re-rolls the sample gate independently, so a chatty page does not
 * pin the whole session "on" off a single early draw — the bound holds per event.
 */
export function reportClientErrors(options: BeaconOptions = {}): {
  onMountError: (error: unknown, info: { component: string }) => void;
  onRecoverableError: (error: unknown) => void;
  report: (result: HydrationOutcome) => void;
} {
  const rate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const dev = options.dev ?? false;
  const random = options.random ?? Math.random;
  const send = options.send ?? defaultSend;
  const overlay = options.overlay ?? defaultOverlay;

  function emit(event: BeaconEvent): void {
    const payload: BeaconPayload = { v: 1, events: [event] };

    // Dev paints the overlay unconditionally (no sampling — a developer wants
    // every signal); prod gates on the bounded rate before it ever touches fetch.
    if (dev) {
      overlay(payload);

      return;
    }

    if (!shouldSample(rate, random)) return;

    send(BEACON_PATH, payload);
  }

  return {
    onMountError: (error, info) => {
      emit({ kind: "mount-error", component: info.component, errorClass: errorClass(error) });
    },

    onRecoverableError: (error) => {
      emit({ kind: "recoverable-error", errorClass: errorClass(error) });
    },

    // Report the pass summary only when something actually went wrong — a clean
    // hydrate is silent, so the beacon's signal-to-noise stays high.
    report: (result) => {
      if (result.failed.length === 0 && result.missing.length === 0) return;

      emit(hydrateEvent(result));
    },
  };
}
