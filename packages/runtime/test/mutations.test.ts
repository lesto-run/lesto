import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { generateToken } from "@lesto/csrf";
import type { LestoRequest } from "@lesto/web";

import { MutationError } from "../src/errors";
import { defineMutation, mutationRoutes, MUTATION_ROUTE_PREFIX } from "../src/mutations";
import type { MutationContractOf, MutationResult } from "../src/mutations";

// A ≥32-byte secret — `@lesto/csrf` refuses anything weaker.
const SECRET = "x".repeat(40);
const SESSION = "session-abc";

/** Parse a JSON response body. */
function parse<T>(body: string): T {
  return JSON.parse(body) as T;
}

/** A sample mutation set used across the suite. */
const renameListing = defineMutation({
  name: "renameListing",
  input: z.object({ id: z.string().min(1), name: z.string().trim().min(1) }),
  handler: (input) => ({ listing: { id: input.id, name: input.name } }),
});

const locked = defineMutation({
  name: "locked",
  input: z.object({ id: z.string() }),
  handler: () => {
    throw new MutationError("LISTING_LOCKED", "The listing is locked.", { status: 409 });
  },
});

const boom = defineMutation({
  name: "boom",
  input: z.object({}),
  handler: () => {
    throw new Error("a real bug");
  },
});

const map = { renameListing, locked, boom };

describe("defineMutation — the typed define side", () => {
  it("carries the parsed input type and the handler output type", () => {
    expectTypeOf(renameListing.name).toEqualTypeOf<string>();

    // The contract projection exposes the inferred input/output to the client.
    type Contract = MutationContractOf<typeof map>;
    expectTypeOf<Contract["renameListing"]["input"]>().toEqualTypeOf<{
      id: string;
      name: string;
    }>();
    expectTypeOf<Contract["renameListing"]["output"]>().toEqualTypeOf<{
      listing: { id: string; name: string };
    }>();
  });
});

describe("mutationRoutes — the boundary (no CSRF configured)", () => {
  it("dispatches a valid call and answers the success arm", async () => {
    const app = mutationRoutes(map);

    const response = await app.handle("POST", `${MUTATION_ROUTE_PREFIX}/renameListing`, {
      headers: { "content-type": "application/json" },
      body: { id: "3", name: "New" },
    });

    expect(response.status).toBe(200);
    expect(parse<MutationResult<unknown>>(response.body)).toEqual({
      ok: true,
      data: { listing: { id: "3", name: "New" } },
    });
  });

  it("404s an unknown mutation name with a typed error arm", async () => {
    const app = mutationRoutes(map);

    const response = await app.handle("POST", `${MUTATION_ROUTE_PREFIX}/nope`, {
      headers: { "content-type": "application/json" },
      body: {},
    });

    expect(response.status).toBe(404);
    expect(parse<MutationResult<unknown>>(response.body)).toEqual({
      ok: false,
      error: { code: "MUTATION_NOT_FOUND", message: 'No mutation named "nope".' },
    });
  });

  it("422s an input that fails the Zod schema (the handler never runs)", async () => {
    const app = mutationRoutes(map);

    const response = await app.handle("POST", `${MUTATION_ROUTE_PREFIX}/renameListing`, {
      headers: { "content-type": "application/json" },
      body: { id: "", name: "" },
    });

    expect(response.status).toBe(422);
    const result = parse<MutationResult<unknown>>(response.body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MUTATION_INVALID_INPUT");
  });

  it("maps a handler's MutationError to the typed failure arm with its chosen status", async () => {
    const app = mutationRoutes(map);

    const response = await app.handle("POST", `${MUTATION_ROUTE_PREFIX}/locked`, {
      headers: { "content-type": "application/json" },
      body: { id: "3" },
    });

    expect(response.status).toBe(409);
    expect(parse<MutationResult<unknown>>(response.body)).toEqual({
      ok: false,
      error: { code: "LISTING_LOCKED", message: "The listing is locked." },
    });
  });

  it("defaults a MutationError with no status to 400", async () => {
    const noStatus = defineMutation({
      name: "noStatus",
      input: z.object({}),
      handler: () => {
        throw new MutationError("REFUSED", "nope");
      },
    });

    const response = await mutationRoutes({ noStatus }).handle(
      "POST",
      `${MUTATION_ROUTE_PREFIX}/noStatus`,
      { headers: { "content-type": "application/json" }, body: {} },
    );

    expect(response.status).toBe(400);
  });

  it("defaults a MutationError with an out-of-range status to 400", async () => {
    const badStatus = defineMutation({
      name: "badStatus",
      input: z.object({}),
      handler: () => {
        throw new MutationError("REFUSED", "nope", { status: 200 });
      },
    });

    const response = await mutationRoutes({ badStatus }).handle(
      "POST",
      `${MUTATION_ROUTE_PREFIX}/badStatus`,
      { headers: { "content-type": "application/json" }, body: {} },
    );

    expect(response.status).toBe(400);
  });

  it("re-throws a non-MutationError so the app's error boundary owns it (a 500, not a leaked typed error)", async () => {
    const app = mutationRoutes(map);

    await expect(
      app.handle("POST", `${MUTATION_ROUTE_PREFIX}/boom`, {
        headers: { "content-type": "application/json" },
        body: {},
      }),
    ).rejects.toThrow("a real bug");
  });

  it("awaits an async handler's resolved value", async () => {
    const asyncMutation = defineMutation({
      name: "asyncMutation",
      input: z.object({ n: z.number() }),
      handler: (input) => Promise.resolve({ doubled: input.n * 2 }),
    });

    const response = await mutationRoutes({ asyncMutation }).handle(
      "POST",
      `${MUTATION_ROUTE_PREFIX}/asyncMutation`,
      { headers: { "content-type": "application/json" }, body: { n: 21 } },
    );

    expect(parse<MutationResult<{ doubled: number }>>(response.body)).toEqual({
      ok: true,
      data: { doubled: 42 },
    });
  });
});

describe("mutationRoutes — the CSRF boundary (reusing @lesto/csrf)", () => {
  const csrf = { secret: SECRET, sessionFor: (_r: LestoRequest) => SESSION };

  it("403s a guarded call with no token (fail-closed)", async () => {
    const app = mutationRoutes(map, { csrf });

    const response = await app.handle("POST", `${MUTATION_ROUTE_PREFIX}/renameListing`, {
      headers: { "content-type": "application/json" },
      body: { id: "3", name: "New" },
    });

    expect(response.status).toBe(403);
    expect(parse<MutationResult<unknown>>(response.body).ok).toBe(false);
    expect(parse<{ error: { code: string } }>(response.body).error.code).toBe(
      "MUTATION_CSRF_FAILED",
    );
  });

  it("403s a token bound to a DIFFERENT session", async () => {
    const app = mutationRoutes(map, { csrf });
    const wrongToken = generateToken("other-session", SECRET);

    const response = await app.handle("POST", `${MUTATION_ROUTE_PREFIX}/renameListing`, {
      headers: { "content-type": "application/json", "x-csrf-token": wrongToken },
      body: { id: "3", name: "New" },
    });

    expect(response.status).toBe(403);
  });

  it("passes a valid token bound to the request's session", async () => {
    const app = mutationRoutes(map, { csrf });
    const token = generateToken(SESSION, SECRET);

    const response = await app.handle("POST", `${MUTATION_ROUTE_PREFIX}/renameListing`, {
      headers: { "content-type": "application/json", "x-csrf-token": token },
      body: { id: "3", name: "New" },
    });

    expect(response.status).toBe(200);
    expect(parse<MutationResult<unknown>>(response.body).ok).toBe(true);
  });

  it("runs the CSRF check BEFORE Zod (a forged token on an invalid body is still a 403)", async () => {
    const app = mutationRoutes(map, { csrf });

    const response = await app.handle("POST", `${MUTATION_ROUTE_PREFIX}/renameListing`, {
      headers: { "content-type": "application/json", "x-csrf-token": "forged.sig" },
      body: { id: "", name: "" },
    });

    expect(response.status).toBe(403);
  });

  it("honours a custom extractToken (e.g. a different header)", async () => {
    const token = generateToken(SESSION, SECRET);
    const app = mutationRoutes(map, {
      csrf: {
        secret: SECRET,
        sessionFor: () => SESSION,
        extractToken: (r) => r.headers["x-alt-csrf"],
      },
    });

    const response = await app.handle("POST", `${MUTATION_ROUTE_PREFIX}/renameListing`, {
      headers: { "content-type": "application/json", "x-alt-csrf": token },
      body: { id: "3", name: "New" },
    });

    expect(response.status).toBe(200);
  });

  it("treats an empty-string token header as no token (403)", async () => {
    const app = mutationRoutes(map, { csrf });

    const response = await app.handle("POST", `${MUTATION_ROUTE_PREFIX}/renameListing`, {
      headers: { "content-type": "application/json", "x-csrf-token": "" },
      body: { id: "3", name: "New" },
    });

    expect(response.status).toBe(403);
  });
});

describe("MutationError", () => {
  it("is a coded LestoError carrying its details", () => {
    const error = new MutationError("CODE", "msg", { status: 409, extra: 1 });

    expect(error.name).toBe("MutationError");
    expect(error.code).toBe("CODE");
    expect(error.details).toEqual({ status: 409, extra: 1 });
  });

  it("defaults details to an empty object", () => {
    expect(new MutationError("CODE", "msg").details).toEqual({});
  });
});
