import { describe, expect, it } from "vitest";

import { LestoError } from "@lesto/errors";

import {
  bodyForStatus,
  DEFAULT_SECURITY_HEADERS,
  RECOMMENDED_CSP,
  securityDefaults,
  statusForError,
  withSecurityHeaders,
} from "../src/index";

import { mergeHeaders } from "../src/harden";

import type { AnyLestoResponse } from "../src/index";

const response = (headers: Record<string, string> = {}): AnyLestoResponse => ({
  status: 200,
  headers,
  body: "ok",
});

describe("withSecurityHeaders", () => {
  it("merges the defaults under a response, leaving its own headers to win", () => {
    const hardened = withSecurityHeaders(response({ "x-frame-options": "SAMEORIGIN" }), {
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
    });

    // The response's own value wins the merge, de-duped case-insensitively onto a
    // SINGLE entry (the default's `X-Frame-Options` casing) — never two collided
    // case variants that would emit the header twice on the wire. A default the
    // response did not set is added.
    expect(hardened.headers["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(hardened.headers["x-frame-options"]).toBeUndefined();
    expect(hardened.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("returns the response untouched when headers are disabled (false)", () => {
    const original = response({ a: "b" });

    expect(withSecurityHeaders(original, false)).toBe(original);
  });
});

describe("securityDefaults", () => {
  it("returns false untouched when the base is disabled", () => {
    expect(securityDefaults(false, {})).toBe(false);
  });

  it("returns the base unchanged when no CSP or COEP is configured", () => {
    expect(securityDefaults({ ...DEFAULT_SECURITY_HEADERS }, {})).toEqual(DEFAULT_SECURITY_HEADERS);
  });

  it("adds an enforcing CSP under Content-Security-Policy", () => {
    const headers = securityDefaults({}, { csp: { policy: RECOMMENDED_CSP, mode: "enforce" } });

    expect(headers).not.toBe(false);
    expect((headers as Record<string, string>)["Content-Security-Policy"]).toBe(RECOMMENDED_CSP);
  });

  it("adds a report-only CSP under Content-Security-Policy-Report-Only", () => {
    const headers = securityDefaults({}, { csp: { policy: RECOMMENDED_CSP, mode: "report-only" } });

    expect((headers as Record<string, string>)["Content-Security-Policy-Report-Only"]).toBe(
      RECOMMENDED_CSP,
    );
    expect((headers as Record<string, string>)["Content-Security-Policy"]).toBeUndefined();
  });

  it("adds COEP require-corp only when explicitly enabled", () => {
    const on = securityDefaults({}, { crossOriginEmbedderPolicy: true });
    const off = securityDefaults({}, { crossOriginEmbedderPolicy: false });

    expect((on as Record<string, string>)["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
    expect((off as Record<string, string>)["Cross-Origin-Embedder-Policy"]).toBeUndefined();
  });
});

describe("mergeHeaders", () => {
  it("keeps the under headers when the over map is empty", () => {
    expect(mergeHeaders({ "content-type": "text/html" }, {})).toEqual({
      "content-type": "text/html",
    });
  });

  it("lets an over header win, de-duped onto one entry across casing", () => {
    // Under `X-Frame-Options`, over `x-frame-options`: one entry, over wins, under
    // the under-layer's casing — never two collided variants.
    const merged = mergeHeaders({ "X-Frame-Options": "DENY" }, { "x-frame-options": "SAMEORIGIN" });

    expect(merged).toEqual({ "X-Frame-Options": "SAMEORIGIN" });
  });

  it("accumulates Set-Cookie from both layers instead of clobbering", () => {
    // Two middleware layers each set a cookie; both must reach the wire.
    const merged = mergeHeaders(
      { "set-cookie": "session=s; HttpOnly" },
      { "set-cookie": "csrf=c; Secure" },
    );

    expect(merged).toEqual({ "set-cookie": ["session=s; HttpOnly", "csrf=c; Secure"] });
  });

  it("accumulates Set-Cookie when the layers are already lists", () => {
    const merged = mergeHeaders({ "set-cookie": ["a=1", "b=2"] }, { "Set-Cookie": ["c=3"] });

    // The under casing wins the key; every cookie from both layers is preserved.
    expect(merged).toEqual({ "set-cookie": ["a=1", "b=2", "c=3"] });
  });

  it("carries a Set-Cookie present in only one layer through untouched", () => {
    expect(mergeHeaders({ "set-cookie": "only=1" }, { "content-type": "text/html" })).toEqual({
      "set-cookie": "only=1",
      "content-type": "text/html",
    });

    expect(mergeHeaders({ "content-type": "text/html" }, { "set-cookie": "only=1" })).toEqual({
      "content-type": "text/html",
      "set-cookie": "only=1",
    });
  });

  it("unions Vary from both layers instead of letting the over side clobber it", () => {
    // The CORS hazard: a policy's `Vary: Origin` (under) merged with a
    // controller's `Vary: Cookie` (over). Last-writer-wins would drop `Origin`
    // and reopen the shared-cache cross-origin leak; the union keeps both.
    const merged = mergeHeaders({ Vary: "Origin" }, { Vary: "Cookie" });

    expect(merged).toEqual({ Vary: "Origin, Cookie" });

    // Guard against a silent regression to clobber: `Origin` must survive.
    expect(merged["Vary"]).toContain("Origin");
    expect(merged["Vary"]).toContain("Cookie");
  });

  it("dedupes Vary tokens case-insensitively under a single key", () => {
    // Different casing on the header name AND on the token: one entry, no
    // duplicate `Origin`, key kept at the under side's canonical casing.
    const merged = mergeHeaders({ Vary: "Origin" }, { vary: "origin, Cookie" });

    expect(merged).toEqual({ Vary: "Origin, Cookie" });
    expect(merged["vary"]).toBeUndefined();
  });

  it("unions a multi-token policy Vary with a controller Vary, none duplicated", () => {
    // A reflected-headers preflight emits `Vary: Origin, Access-Control-Request-Headers`;
    // a controller adds `Vary: Cookie`. All three tokens ride, split on commas.
    const merged = mergeHeaders(
      { Vary: "Origin, Access-Control-Request-Headers" },
      { Vary: "Cookie" },
    );

    expect(merged).toEqual({ Vary: "Origin, Access-Control-Request-Headers, Cookie" });
  });

  it("unions Vary when a layer carries it as a string list", () => {
    // The `string[]` value arm: a header already carried as an array merges as
    // cleanly as a comma-list string.
    const merged = mergeHeaders({ Vary: ["Origin", "Accept"] }, { Vary: "accept, Cookie" });

    expect(merged).toEqual({ Vary: "Origin, Accept, Cookie" });
  });

  it("drops empty Vary tokens from stray commas", () => {
    // A trailing/duplicate comma must not leave a phantom empty token in the union.
    const merged = mergeHeaders({ Vary: "Origin, " }, { Vary: "Cookie,," });

    expect(merged).toEqual({ Vary: "Origin, Cookie" });
  });

  it("carries a Vary present in only one layer through untouched", () => {
    // Over-only Vary: no under Vary to union with, so it passes straight through.
    expect(mergeHeaders({ "content-type": "text/html" }, { Vary: "Origin" })).toEqual({
      "content-type": "text/html",
      Vary: "Origin",
    });

    // Under-only Vary: same, from the other side.
    expect(mergeHeaders({ Vary: "Origin" }, { "content-type": "text/html" })).toEqual({
      Vary: "Origin",
      "content-type": "text/html",
    });
  });

  it("keeps controller-wins for a non-Vary header collision", () => {
    // The union is Vary-specific: an ordinary header still lets the over layer win,
    // so a controller's own Content-Type is not turned into a union.
    expect(
      mergeHeaders({ "content-type": "application/json" }, { "content-type": "text/html" }),
    ).toEqual({ "content-type": "text/html" });
  });
});

describe("statusForError", () => {
  it("maps the coded transport refusals to their statuses", () => {
    expect(statusForError(new LestoError("RUNTIME_INVALID_JSON", "x"))).toBe(400);
    expect(statusForError(new LestoError("RUNTIME_INVALID_REQUEST_TARGET", "x"))).toBe(400);
    expect(statusForError(new LestoError("ROUTER_MALFORMED_PARAM", "x"))).toBe(400);
    expect(statusForError(new LestoError("WEB_VALIDATION_FAILED", "x"))).toBe(422);
    expect(statusForError(new LestoError("RUNTIME_BODY_TOO_LARGE", "x"))).toBe(413);
    expect(statusForError(new LestoError("RUNTIME_HANDLER_TIMEOUT", "x"))).toBe(503);
    expect(statusForError(new LestoError("CLOUDFLARE_DISPATCH_TIMEOUT", "x"))).toBe(503);
  });

  it("maps a foreign-copy coded error (branded, not instanceof) to its status", () => {
    // Reproduces the router/ui 0.1.3 dep-dup: a LestoError thrown from a SECOND copy
    // of @lesto/errors is NOT `instanceof` this copy's class, but carries the same
    // process-global brand. The old `instanceof` gate silently downgraded this coded
    // 400 to a 500; brand-based recognition maps it correctly.
    const foreign: Record<PropertyKey, unknown> = {
      name: "LestoError",
      code: "ROUTER_MALFORMED_PARAM",
      message: "x",
    };

    Object.defineProperty(foreign, Symbol.for("lesto.error"), { value: true });

    expect(foreign instanceof LestoError).toBe(false);
    expect(statusForError(foreign)).toBe(400);
  });

  it("maps any other coded error to a 500", () => {
    expect(statusForError(new LestoError("SOME_OTHER_CODE", "x"))).toBe(500);
  });

  it("maps a non-LestoError throw to a 500", () => {
    // No brand → not recognized → the safe default holds. A bare object shaped like
    // an error (a `{ code }` with NO brand) must NOT be coerced into a coded status.
    expect(statusForError(new Error("plain"))).toBe(500);
    expect(statusForError(new TypeError("nope"))).toBe(500);
    expect(statusForError({ code: "ROUTER_MALFORMED_PARAM" })).toBe(500);
    expect(statusForError("a string thrown")).toBe(500);
  });
});

describe("bodyForStatus", () => {
  it("returns a safe, internals-free body for each status", () => {
    expect(bodyForStatus(400)).toBe("Bad Request");
    expect(bodyForStatus(422)).toBe("Unprocessable Entity");
    expect(bodyForStatus(413)).toBe("Payload Too Large");
    expect(bodyForStatus(503)).toBe("Service Unavailable");
    expect(bodyForStatus(500)).toBe("Internal Server Error");
    expect(bodyForStatus(418)).toBe("Internal Server Error");
  });
});
