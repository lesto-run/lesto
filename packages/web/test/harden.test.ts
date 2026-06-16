import { describe, expect, it } from "vitest";

import { KeelError } from "@keel/errors";

import {
  bodyForStatus,
  DEFAULT_SECURITY_HEADERS,
  RECOMMENDED_CSP,
  securityDefaults,
  statusForError,
  withSecurityHeaders,
} from "../src/index";

import type { AnyKeelResponse } from "../src/index";

const response = (headers: Record<string, string> = {}): AnyKeelResponse => ({
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

    // The response's own value wins the merge; a default it didn't set is added.
    expect(hardened.headers["x-frame-options"]).toBe("SAMEORIGIN");
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

describe("statusForError", () => {
  it("maps the coded transport refusals to their statuses", () => {
    expect(statusForError(new KeelError("RUNTIME_INVALID_JSON", "x"))).toBe(400);
    expect(statusForError(new KeelError("ROUTER_MALFORMED_PARAM", "x"))).toBe(400);
    expect(statusForError(new KeelError("WEB_VALIDATION_FAILED", "x"))).toBe(422);
    expect(statusForError(new KeelError("RUNTIME_BODY_TOO_LARGE", "x"))).toBe(413);
    expect(statusForError(new KeelError("RUNTIME_HANDLER_TIMEOUT", "x"))).toBe(503);
  });

  it("maps any other coded error to a 500", () => {
    expect(statusForError(new KeelError("SOME_OTHER_CODE", "x"))).toBe(500);
  });

  it("maps a non-KeelError throw to a 500", () => {
    expect(statusForError(new Error("plain"))).toBe(500);
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
