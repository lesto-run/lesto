import { describe, expect, it, vi } from "vitest";

import {
  CSRF_DENIED_KIND,
  csrf,
  CsrfError,
  defaultExtractToken,
  generateToken,
} from "../src/index";

import type { AnyVoloResponse, VoloRequest } from "@volo/web";

// >= 32 bytes: a real CSRF secret (the weak-secret guard rejects shorter).
const SECRET = "test-secret-0123456789abcdefghijk";
const SESSION = "session-42";

function requestWith(overrides: Partial<VoloRequest> = {}): VoloRequest {
  return {
    method: "POST",
    path: "/",
    params: {},
    query: {},
    headers: {},
    body: undefined,
    ...overrides,
  };
}

const okResponse: AnyVoloResponse = { status: 200, headers: {}, body: "ok" };

const sessionFor = (): string => SESSION;

describe("csrf middleware", () => {
  it("lets a safe (unguarded) method through without a token", async () => {
    const middleware = csrf({ secret: SECRET, sessionFor });

    const response = await middleware(requestWith({ method: "GET" }), async () => okResponse);

    expect(response.status).toBe(200);
  });

  it("throws CSRF_WEAK_SECRET at construction for a short secret (batched P1)", () => {
    try {
      csrf({ secret: "short", sessionFor });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CsrfError);
      expect((e as CsrfError).code).toBe("CSRF_WEAK_SECRET");
    }

    // The 32-byte boundary is inclusive — a real secret builds fine.
    expect(() => csrf({ secret: "a".repeat(32), sessionFor })).not.toThrow();
  });

  it("accepts a guarded request carrying a valid token (header)", async () => {
    const token = generateToken(SESSION, SECRET);
    const middleware = csrf({ secret: SECRET, sessionFor });

    const response = await middleware(
      requestWith({ method: "POST", headers: { "x-csrf-token": token } }),
      async () => okResponse,
    );

    expect(response.status).toBe(200);
  });

  it("accepts a valid token from a form-urlencoded body field", async () => {
    const token = generateToken(SESSION, SECRET);
    const middleware = csrf({ secret: SECRET, sessionFor });

    const response = await middleware(
      requestWith({ method: "POST", body: `_csrf=${token}&name=ada` }),
      async () => okResponse,
    );

    expect(response.status).toBe(200);
  });

  it("rejects a guarded request with no token (403, fail-closed)", async () => {
    const middleware = csrf({ secret: SECRET, sessionFor });

    const response = await middleware(requestWith({ method: "POST" }), async () => okResponse);

    expect(response.status).toBe(403);
    expect(response.body).toBe("Forbidden");
  });

  it("rejects a token minted for a different session", async () => {
    const tokenForOther = generateToken("someone-else", SECRET);
    const middleware = csrf({ secret: SECRET, sessionFor });

    const response = await middleware(
      requestWith({ method: "POST", headers: { "x-csrf-token": tokenForOther } }),
      async () => okResponse,
    );

    expect(response.status).toBe(403);
  });

  it("guards only the configured methods", async () => {
    const middleware = csrf({ secret: SECRET, sessionFor, methods: ["DELETE"] });

    // POST is no longer guarded, so it passes without a token...
    const post = await middleware(requestWith({ method: "POST" }), async () => okResponse);
    expect(post.status).toBe(200);

    // ...but DELETE is, so a token-less DELETE is forbidden.
    const del = await middleware(requestWith({ method: "DELETE" }), async () => okResponse);
    expect(del.status).toBe(403);
  });

  it("uses a custom extractToken when provided", async () => {
    const token = generateToken(SESSION, SECRET);

    const middleware = csrf({
      secret: SECRET,
      sessionFor,
      extractToken: (req) => req.query["t"],
    });

    const response = await middleware(
      requestWith({ method: "POST", query: { t: token } }),
      async () => okResponse,
    );

    expect(response.status).toBe(200);
  });

  it("fires onDenied with the coded kind and the refused request on a 403", async () => {
    const onDenied = vi.fn();
    const middleware = csrf({ secret: SECRET, sessionFor, onDenied });

    const request = requestWith({ method: "POST" });
    const response = await middleware(request, async () => okResponse);

    // The refusal stands exactly as before — the hook only watches.
    expect(response.status).toBe(403);

    expect(onDenied).toHaveBeenCalledTimes(1);
    expect(onDenied).toHaveBeenCalledWith(CSRF_DENIED_KIND, request);
    expect(CSRF_DENIED_KIND).toBe("csrf_token_invalid");
  });

  it("awaits an async onDenied before answering, and never fires it on an allowed request", async () => {
    const seen: string[] = [];
    const onDenied = async (kind: string): Promise<void> => {
      seen.push(kind);
    };
    const middleware = csrf({ secret: SECRET, sessionFor, onDenied });

    // An allowed request: a valid token means no refusal, so onDenied stays silent.
    const token = generateToken(SESSION, SECRET);
    const allowed = await middleware(
      requestWith({ method: "POST", headers: { "x-csrf-token": token } }),
      async () => okResponse,
    );
    expect(allowed.status).toBe(200);
    expect(seen).toEqual([]);

    // A refused request awaits the async hook, then returns the 403.
    const refused = await middleware(requestWith({ method: "POST" }), async () => okResponse);
    expect(refused.status).toBe(403);
    expect(seen).toEqual([CSRF_DENIED_KIND]);
  });
});

describe("defaultExtractToken", () => {
  it("prefers the x-csrf-token header", () => {
    expect(defaultExtractToken(requestWith({ headers: { "x-csrf-token": "abc" } }))).toBe("abc");
  });

  it("ignores an empty header and falls through to the body", () => {
    const request = requestWith({ headers: { "x-csrf-token": "" }, body: "_csrf=fromBody" });

    expect(defaultExtractToken(request)).toBe("fromBody");
  });

  it("reads the _csrf form field from a string body", () => {
    expect(defaultExtractToken(requestWith({ body: "_csrf=field&x=1" }))).toBe("field");
  });

  it("returns undefined when the form body has no _csrf field", () => {
    expect(defaultExtractToken(requestWith({ body: "x=1" }))).toBeUndefined();
  });

  it("returns undefined when the body is empty (no field present)", () => {
    expect(defaultExtractToken(requestWith({ body: "_csrf=" }))).toBeUndefined();
  });

  it("returns undefined when the body is not a string", () => {
    expect(defaultExtractToken(requestWith({ body: { json: true } }))).toBeUndefined();
  });

  it("returns undefined when neither header nor body carries a token", () => {
    expect(defaultExtractToken(requestWith())).toBeUndefined();
  });
});
