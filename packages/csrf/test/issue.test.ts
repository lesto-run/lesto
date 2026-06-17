import { describe, expect, it } from "vitest";

import { CSRF_COOKIE, CsrfError, csrfToken, verifyToken } from "../src/index";

// >= 32 bytes: a real CSRF secret (the weak-secret guard rejects shorter).
const SECRET = "a-server-side-secret-0123456789ab";
const SESSION = "session_a";

describe("csrfToken — double-submit issuance", () => {
  it("mints a token that verifies for the session it was bound to", () => {
    const { token } = csrfToken(SESSION, SECRET);

    expect(verifyToken(token, SESSION, SECRET)).toBe(true);
  });

  it("does not verify under a different session (HMAC binding holds)", () => {
    const { token } = csrfToken(SESSION, SECRET);

    expect(verifyToken(token, "session_b", SECRET)).toBe(false);
  });

  it("sets a companion cookie carrying the SAME token value (the double submit)", () => {
    const { token, cookie } = csrfToken(SESSION, SECRET);

    // The cookie value is exactly the issued token — that equality IS the pair:
    // the page reads it from the cookie and resubmits it on a second channel.
    expect(cookie.startsWith(`${CSRF_COOKIE}=${token};`)).toBe(true);
  });

  it("serializes the companion cookie with Secure, SameSite=Strict, Path=/ and NO HttpOnly", () => {
    const { cookie } = csrfToken(SESSION, SECRET);

    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    // The page must read the value back, so the companion is deliberately not HttpOnly.
    expect(cookie).not.toContain("HttpOnly");
  });

  it("defaults the cookie name to CSRF_COOKIE", () => {
    const { cookie } = csrfToken(SESSION, SECRET);

    expect(CSRF_COOKIE).toBe("csrf_token");
    expect(cookie.startsWith("csrf_token=")).toBe(true);
  });

  it("honors a custom cookie name", () => {
    const { token, cookie } = csrfToken(SESSION, SECRET, { cookieName: "__Host-csrf" });

    expect(cookie.startsWith(`__Host-csrf=${token};`)).toBe(true);
  });

  it("mints a fresh token (and cookie) every call", () => {
    expect(csrfToken(SESSION, SECRET).token).not.toBe(csrfToken(SESSION, SECRET).token);
  });

  it("refuses a weak secret loud (CSRF_WEAK_SECRET), inherited from generateToken", () => {
    try {
      csrfToken(SESSION, "too-short");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CsrfError);
      expect((e as CsrfError).code).toBe("CSRF_WEAK_SECRET");
    }
  });
});
