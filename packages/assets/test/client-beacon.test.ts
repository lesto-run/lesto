// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { LestoError } from "@lesto/errors";

import {
  BEACON_PATH,
  DEFAULT_SAMPLE_RATE,
  defaultOverlay,
  defaultSend,
  errorClass,
  hydrateEvent,
  reportClientErrors,
  shouldSample,
} from "../src/client-beacon";
import type { BeaconEvent, BeaconPayload } from "../src/client-beacon";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// errorClass — PII-free distillation of any thrown value to a code/class string.
// ---------------------------------------------------------------------------

describe("errorClass", () => {
  it("prefers a LestoError's stable code (the deploy-skew signal)", () => {
    const error = new LestoError("UI_ISLAND_UNKNOWN_COMPONENT", "Account is gone");

    expect(errorClass(error)).toBe("UI_ISLAND_UNKNOWN_COMPONENT");
  });

  it("falls back to the constructor name for a plain Error (never the message)", () => {
    const error = new TypeError("user 4242 is not a function");

    expect(errorClass(error)).toBe("TypeError");
    // The point of the whole exercise: the message — where user data hides — is gone.
    expect(errorClass(error)).not.toContain("4242");
  });

  it("ignores a non-string or empty code and reads the constructor instead", () => {
    const numeric = { code: 500 };
    const empty = Object.assign(new RangeError("x"), { code: "" });

    expect(errorClass(numeric)).toBe("Object");
    expect(errorClass(empty)).toBe("RangeError");
  });

  it("reports only the typeof a thrown primitive — never its value", () => {
    // `throw "secret-token"` must not leak the token; we send "string".
    expect(errorClass("secret-token")).toBe("string");
    expect(errorClass(42)).toBe("number");
    expect(errorClass(null)).toBe("object");
  });

  it("survives an object with no usable constructor name", () => {
    const bare = Object.create(null) as Record<string, unknown>;

    // No prototype → no constructor → falls through to typeof.
    expect(errorClass(bare)).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// hydrateEvent — the pass summary: counts only (plus the kind tag).
// ---------------------------------------------------------------------------

describe("hydrateEvent", () => {
  it("carries the failed/missing counts and nothing else", () => {
    const event = hydrateEvent({ failed: ["$.children[0]", "$.children[3]"], missing: ["$.x"] });

    expect(event).toEqual({ kind: "hydrate", failed: 2, missing: 1 });
    // No island ids in the payload — counts only, so no route path can ride along.
    expect(JSON.stringify(event)).not.toContain("$.children");
  });
});

// ---------------------------------------------------------------------------
// shouldSample — the bounded rate gate.
// ---------------------------------------------------------------------------

describe("shouldSample", () => {
  it("never reports at rate 0 and below (a disabled beacon)", () => {
    expect(shouldSample(0, () => 0)).toBe(false);
    expect(shouldSample(-1, () => 0)).toBe(false);
  });

  it("always reports at rate 1 and above (without even drawing)", () => {
    const random = vi.fn(() => 0.999);

    expect(shouldSample(1, random)).toBe(true);
    expect(shouldSample(2, random)).toBe(true);
    // The >= 1 short-circuit means the source is never consulted.
    expect(random).not.toHaveBeenCalled();
  });

  it("reports iff the draw lands under the rate (the gate)", () => {
    // A draw below the rate passes; a draw at/above it does not.
    expect(shouldSample(0.25, () => 0.1)).toBe(true);
    expect(shouldSample(0.25, () => 0.25)).toBe(false);
    expect(shouldSample(0.25, () => 0.9)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// defaultSend — the real fetch transport (jsdom + a stubbed fetch).
// ---------------------------------------------------------------------------

describe("defaultSend", () => {
  it("POSTs the payload as keepalive JSON to the beacon path", () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response()));
    vi.stubGlobal("fetch", fetchMock);

    const payload: BeaconPayload = { v: 1, events: [{ kind: "recoverable-error" }] };
    defaultSend(BEACON_PATH, payload);

    expect(fetchMock).toHaveBeenCalledWith(
      "/__lesto/client-errors",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
  });

  it("swallows a rejected POST — a dead beacon never becomes a second error", async () => {
    const rejection = Promise.reject(new Error("offline"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => rejection),
    );

    // The call itself must not throw…
    expect(() => defaultSend(BEACON_PATH, { v: 1, events: [] })).not.toThrow();

    // …and the rejection is caught, so the microtask queue drains cleanly.
    await rejection.catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// defaultOverlay — the ADR-0011 dev overlay (jsdom document).
// ---------------------------------------------------------------------------

describe("defaultOverlay", () => {
  it("appends a dismissible banner naming each event, with no PII", () => {
    const payload: BeaconPayload = {
      v: 1,
      events: [
        { kind: "mount-error", component: "Account", errorClass: "TypeError" },
        { kind: "hydrate", failed: 1, missing: 2 },
        { kind: "recoverable-error", errorClass: "MISMATCH" },
      ],
    };

    defaultOverlay(payload);

    const box = document.querySelector("[data-lesto-error-overlay]");
    expect(box).not.toBeNull();

    const text = box?.textContent ?? "";
    expect(text).toContain("[lesto] mount-error Account: TypeError");
    expect(text).toContain("[lesto] hydrate (failed 1, missing 2)");
    expect(text).toContain("[lesto] recoverable-error: MISMATCH");
  });

  it("renders an event missing its optional fields without leaking 'undefined'", () => {
    // A hydrate event with no counts set still reads cleanly (the `?? 0` default).
    const payload: BeaconPayload = { v: 1, events: [{ kind: "hydrate" }] };

    defaultOverlay(payload);

    const text = document.querySelector("[data-lesto-error-overlay]")?.textContent ?? "";
    expect(text).toBe("[lesto] hydrate (failed 0, missing 0)");
    expect(text).not.toContain("undefined");
  });

  it("dismisses itself on click", () => {
    defaultOverlay({ v: 1, events: [{ kind: "recoverable-error" }] });

    const box = document.querySelector<HTMLElement>("[data-lesto-error-overlay]");
    box?.click();

    expect(document.querySelector("[data-lesto-error-overlay]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reportClientErrors — the wired sinks the synthesized entry consumes.
// ---------------------------------------------------------------------------

/** A reporter wired to a recording `send`, with sampling forced ON unless overridden. */
function recordingReporter(overrides: Parameters<typeof reportClientErrors>[0] = {}) {
  const sent: { path: string; payload: BeaconPayload }[] = [];

  const reporter = reportClientErrors({
    sampleRate: 1,
    send: (path, payload) => sent.push({ path, payload }),
    ...overrides,
  });

  return { reporter, sent };
}

describe("reportClientErrors", () => {
  it("POSTs a PII-free mount-error event (component name + error class)", () => {
    const { reporter, sent } = recordingReporter();

    reporter.onMountError(new TypeError("user 99 blew up"), { component: "Cart" });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(BEACON_PATH);
    expect(sent[0]?.payload).toEqual<BeaconPayload>({
      v: 1,
      events: [{ kind: "mount-error", component: "Cart", errorClass: "TypeError" }],
    });
    // The thrown message never crosses the wire.
    expect(JSON.stringify(sent[0]?.payload)).not.toContain("user 99");
  });

  it("POSTs a recoverable-error event carrying only the error class", () => {
    const { reporter, sent } = recordingReporter();

    reporter.onRecoverableError(new LestoError("UI_HYDRATION_MISMATCH", "secret"));

    expect(sent[0]?.payload.events).toEqual<BeaconEvent[]>([
      { kind: "recoverable-error", errorClass: "UI_HYDRATION_MISMATCH" },
    ]);
  });

  it("reports the hydrate summary only when something went wrong", () => {
    const { reporter, sent } = recordingReporter();

    // A clean pass is silent — high signal-to-noise.
    reporter.report({ failed: [], missing: [], mounted: ["a"], deferred: [] } as never);
    expect(sent).toHaveLength(0);

    // A pass with breakage reports counts.
    reporter.report({ failed: ["$.a"], missing: ["$.b", "$.c"] } as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.events[0]).toEqual({ kind: "hydrate", failed: 1, missing: 2 });
  });

  it("gates every POST on the bounded sample rate (proves the rate, per event)", () => {
    // A scripted source: first draw passes (< rate), second fails (>= rate).
    const draws = [0.05, 0.5];
    let i = 0;
    const { reporter, sent } = recordingReporter({
      sampleRate: 0.1,
      random: () => draws[i++] ?? 1,
    });

    reporter.onRecoverableError(new Error("a")); // 0.05 < 0.1 → sent
    reporter.onRecoverableError(new Error("b")); // 0.5  >= 0.1 → dropped

    expect(sent).toHaveLength(1);
  });

  it("never POSTs when sampling is off (rate 0)", () => {
    const { reporter, sent } = recordingReporter({ sampleRate: 0 });

    reporter.onMountError(new Error("x"), { component: "A" });
    reporter.onRecoverableError(new Error("y"));
    reporter.report({ failed: ["$.a"], missing: [] } as never);

    expect(sent).toHaveLength(0);
  });

  it("in dev mode paints the overlay and POSTs nothing — even with sampling at 1", () => {
    const overlaid: BeaconPayload[] = [];
    const sent: BeaconPayload[] = [];

    const reporter = reportClientErrors({
      dev: true,
      sampleRate: 1,
      overlay: (payload) => overlaid.push(payload),
      send: (_path, payload) => sent.push(payload),
    });

    reporter.onMountError(new Error("x"), { component: "Widget" });
    reporter.report({ failed: ["$.a"], missing: [] } as never);

    // Dev sees every signal on the overlay…
    expect(overlaid).toHaveLength(2);
    expect(overlaid[0]?.events[0]).toMatchObject({ kind: "mount-error", component: "Widget" });
    // …and the network is never touched.
    expect(sent).toHaveLength(0);
  });

  it("defaults the sample rate to the conservative module default", () => {
    // No sampleRate given: a draw at exactly the default rate is rejected (gate is
    // strict `<`), proving the default flowed through.
    const reporter = reportClientErrors({
      send: () => expect.unreachable("a draw == DEFAULT_SAMPLE_RATE must not report"),
      random: () => DEFAULT_SAMPLE_RATE,
    });

    reporter.onRecoverableError(new Error("z"));
  });

  it("falls back to the real defaults (Math.random + fetch) when nothing is injected", () => {
    // Force the gate open with a deterministic Math.random, then assert the real
    // defaultSend ran by observing the stubbed fetch — covering the `?? Math.random`
    // and `?? defaultSend` default-seams in one shot.
    const fetchMock = vi.fn((_input: unknown, _init?: unknown) => Promise.resolve(new Response()));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Math, "random").mockReturnValue(0); // 0 < 1 → always reports

    const reporter = reportClientErrors({ sampleRate: 1 });
    reporter.onRecoverableError(new Error("boom"));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      BEACON_PATH,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses the real defaultOverlay when none is injected in dev", () => {
    const reporter = reportClientErrors({ dev: true });

    reporter.onMountError(new Error("x"), { component: "Profile" });

    const box = document.querySelector("[data-lesto-error-overlay]");
    expect(box?.textContent).toContain("Profile");
  });
});
