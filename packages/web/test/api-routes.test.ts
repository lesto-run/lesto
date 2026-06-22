import { describe, expect, expectTypeOf, it } from "vitest";

import { apiRoutes, lesto } from "../src/lesto";
import type { ContractOf, JsonOf, TypedResponse } from "../src/lesto";
import { Context } from "../src/handler-context";
import type { LestoRequest } from "../src/types";

const requestOf = (over: Partial<LestoRequest> = {}): LestoRequest => ({
  method: "GET",
  path: "/",
  params: {},
  query: {},
  headers: {},
  body: undefined,
  ...over,
});

interface Listing {
  id: string;
  title: string;
}

describe("apiRoutes — runtime: registers real routes on a mountable lesto() app", () => {
  it("dispatches each captured verb to its handler, returning the JSON body", async () => {
    const api = apiRoutes()
      .get("/things", (c) => c.json({ verb: "get" }))
      .post("/things", (c) => c.json({ verb: "post" }))
      .put("/things/:id", (c) => c.json({ verb: "put", id: c.param("id") }))
      .patch("/things/:id", (c) => c.json({ verb: "patch", id: c.param("id") }))
      .delete("/things/:id", (c) => c.json({ verb: "delete", id: c.param("id") }));

    const app = api.routes();

    expect(JSON.parse((await app.handle("GET", "/things")).body)).toEqual({ verb: "get" });
    expect(JSON.parse((await app.handle("POST", "/things")).body)).toEqual({ verb: "post" });
    expect(JSON.parse((await app.handle("PUT", "/things/1")).body)).toEqual({
      verb: "put",
      id: "1",
    });
    expect(JSON.parse((await app.handle("PATCH", "/things/2")).body)).toEqual({
      verb: "patch",
      id: "2",
    });
    expect(JSON.parse((await app.handle("DELETE", "/things/3")).body)).toEqual({
      verb: "delete",
      id: "3",
    });
  });

  it("returns a plain Lesto from .routes(), so a parent can mount it with .route()", async () => {
    const api = apiRoutes().get("/saved", (c) => c.json({ saved: [1, 2, 3] }));

    // The whole point of mounting: a parent app composes the captured routes as a
    // sub-app, keeping the typed builder OUT of the parent's (non-generic) type.
    const parent = lesto().route("/api", api.routes());

    expect(JSON.parse((await parent.handle("GET", "/api/saved")).body)).toEqual({
      saved: [1, 2, 3],
    });
  });
});

describe("apiRoutes — type: ContractOf projects the captured response shapes", () => {
  it("captures each handler's c.json(...) response into the contract (compile-time)", () => {
    const api = apiRoutes()
      .get("/listings/:id", (c) => c.json<Listing>({ id: c.param("id"), title: "T" }))
      .get("/saved", (c) => c.json({ saved: [] as Listing[] }))
      .post("/sign-out", (c) => c.json({ ok: true as const }));

    type Api = ContractOf<typeof api>;

    // The projection is exactly the `"METHOD /path" → { response }` shape the client
    // consumes — read each captured response back out.
    expectTypeOf<Api["GET /listings/:id"]["response"]>().toEqualTypeOf<Listing>();
    expectTypeOf<Api["GET /saved"]["response"]>().toEqualTypeOf<{ saved: Listing[] }>();
    expectTypeOf<Api["POST /sign-out"]["response"]>().toEqualTypeOf<{ ok: true }>();

    // The runtime app still works — referenced so the const is not dead.
    expect(typeof api.routes().handle).toBe("function");
  });

  it("DRIFT GUARD: a handler returning the wrong shape changes the projected contract", () => {
    // The headline. A handler edited to answer with the wrong shape makes the
    // projected contract carry that wrong shape, so a consumer typed to the OLD
    // shape stops compiling. Proven here by asserting the projection is the
    // DRIFTED type and is NOT the old type.
    const drifted = apiRoutes().get("/listings/:id", (c) => {
      void c;

      return c.json({ totallyWrong: 123 });
    });

    type Drifted = ContractOf<typeof drifted>["GET /listings/:id"]["response"];

    expectTypeOf<Drifted>().toEqualTypeOf<{ totallyWrong: number }>();
    expectTypeOf<Drifted>().not.toEqualTypeOf<Listing>();

    // A value of the OLD contract shape is NOT assignable from the drifted response.
    // @ts-expect-error — the drifted handler no longer satisfies the old { id; title }.
    const old: Listing = null as unknown as Drifted;
    void old;

    expect(typeof drifted.routes().handle).toBe("function");
  });

  it("an empty builder projects an empty contract", () => {
    const api = apiRoutes();

    expectTypeOf<ContractOf<typeof api>>().toEqualTypeOf<Record<never, never>>();

    expect(api.routes().routes()).toEqual([]);
  });

  it("ContractOf of a non-builder is never", () => {
    expectTypeOf<ContractOf<{ not: "a builder" }>>().toEqualTypeOf<never>();
  });
});

describe("c.json — TypedResponse carries the serialized value's type", () => {
  it("is runtime-identical to a JSON response (the phantom is erased)", () => {
    const c = new Context(requestOf());

    const response = c.json({ a: 1 });

    expect(response).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(c.json({}, 201).status).toBe(201);
  });

  it("captures the json value's type (compile-time)", () => {
    const c = new Context(requestOf());

    const response = c.json<Listing>({ id: "1", title: "A" });

    expectTypeOf(response).toEqualTypeOf<TypedResponse<Listing>>();
    expectTypeOf<JsonOf<typeof response>>().toEqualTypeOf<Listing>();
    // A non-typed response yields `never` for JsonOf.
    expectTypeOf<JsonOf<{ status: number }>>().toEqualTypeOf<never>();
  });
});
