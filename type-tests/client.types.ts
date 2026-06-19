/**
 * Type-regression fixtures for `@lesto/client`'s contract-typed surface.
 *
 * The differentiator is that types cross the network BY INFERENCE over a contract
 * you declare once (the `hc` model) — no codegen, no generated client. What this
 * pins:
 *
 *   createApi<Contract>():
 *     - the response type is inferred from the contract's `RouteSpec.response`;
 *     - a path is constrained to the routes the contract declares for that VERB
 *       (`api.get` cannot be handed a POST-only path);
 *     - `:param` segments are REQUIRED and typed (a param-less path needs no
 *       second argument; a param path won't compile without `params`);
 *     - a request `body` / `query` is typed from the spec.
 *
 *   createMutationClient<Contract>():
 *     - each stub takes that mutation's `input` and resolves to the discriminated
 *       `MutationResult<output>` union — the typed error path is a value, not a
 *       throw, so `if (result.ok)` narrows `data` vs `error`;
 *     - a no-arg mutation's input argument is optional, a required one is not.
 *
 * A regression here (a response widening to `unknown`, the param requirement
 * dropping, the result union losing its discriminant) reds `tsc` — runtime tests
 * exercise values, never these inferred shapes.
 */

import { createApi, createMutationClient } from "@lesto/client";
import type { MutationResult } from "@lesto/client";

import type { Equal, Expect } from "./assert";

// ── createApi: response inference + verb/path/param constraints ──────────────────

interface Listing {
  id: string;
  price: number;
}

interface SavedResponse {
  user: { id: string; name: string };
  saved: Listing[];
}

// The contract: keys are `"METHOD /path"`, values are each route's wire types.
// Declared ONCE here; in a real app these reference the same `@lesto/db` row types
// the server handlers use, so client and server cannot drift.
interface EstateApi {
  "GET /mls/saved": { response: SavedResponse };
  "GET /mls/listings/:id": { response: Listing };
  "POST /mls/listings": { response: Listing; body: { price: number } };
  "POST /mls/sign-out": { response: { ok: true } };
}

const api = createApi<EstateApi>();

// The response type is inferred from the contract — a param-less GET returns the
// declared response, NOT `unknown`. We pin it by capturing the awaited result.
async function pinResponses() {
  const saved = await api.get("/mls/saved");
  type _savedResp = Expect<Equal<typeof saved, SavedResponse>>;

  // A `:param` path requires `params`, typed to its segment names.
  const one = await api.get("/mls/listings/:id", { params: { id: "3" } });
  type _oneResp = Expect<Equal<typeof one, Listing>>;

  const created = await api.post("/mls/listings", { body: { price: 100 } });
  type _createdResp = Expect<Equal<typeof created, Listing>>;

  const out = await api.post("/mls/sign-out");
  type _outResp = Expect<Equal<typeof out, { ok: true }>>;

  // Reference the locals so `noUnusedLocals` is satisfied; the assertions above
  // are what actually pin the types.
  return { saved, one, created, out } satisfies {
    saved: SavedResponse;
    one: Listing;
    created: Listing;
    out: { ok: true };
  };
}
void pinResponses;

// @ts-expect-error — `/mls/sign-out` is a POST route; `api.get` must not accept it.
api.get("/mls/sign-out");

// @ts-expect-error — `/nope` is not in the contract; the path is constrained.
api.get("/nope");

// @ts-expect-error — a `:param` path REQUIRES `params`; the call won't compile without it.
api.get("/mls/listings/:id");

// @ts-expect-error — `id` is the only param; an unknown param key must not type-check.
api.get("/mls/listings/:id", { params: { wrong: "3" } });

// @ts-expect-error — the POST body is `{ price: number }`; a string price must not type-check.
api.post("/mls/listings", { body: { price: "free" } });

// A param-less GET needs no second argument at all — this MUST compile.
void api.get("/mls/saved");

// ── createMutationClient: input/output inference + the result union ──────────────

// A mutation contract: name → `{ input; output }` (the shape
// `MutationContractOf<typeof serverMutations>` projects on the server). A `type`
// alias, not an `interface` — `MutationContract` is `Record<string, MutationSpec>`,
// which an `interface` cannot satisfy (no implicit index signature).
type Mutations = {
  renameListing: {
    input: { id: string; name: string };
    output: { listing: Listing };
  };
  signOut: {
    // `undefined extends input` ⇒ the stub takes no required argument.
    input: undefined;
    output: { ok: true };
  };
};

const mutate = createMutationClient<Mutations>({ csrfToken: "t" });

async function pinMutations() {
  const result = await mutate.renameListing({ id: "1", name: "Loft" });

  // The stub resolves to the discriminated union — exactly `MutationResult<output>`.
  type _resultShape = Expect<Equal<typeof result, MutationResult<{ listing: Listing }>>>;

  if (result.ok) {
    // The happy arm narrows `data` to the mutation's `output`.
    type _data = Expect<Equal<typeof result.data, { listing: Listing }>>;
    return result.data.listing;
  }

  // The failure arm narrows to the coded error — a VALUE, never a thrown exception.
  type _err = Expect<Equal<typeof result.error, { code: string; message: string }>>;
  return undefined;
}
void pinMutations;

// A no-arg mutation (`input: undefined`) is callable with no argument.
void mutate.signOut();

// @ts-expect-error — `renameListing` requires its input; calling with none must not type-check.
mutate.renameListing();

// @ts-expect-error — the input shape is `{ id; name }`; a missing `name` must not type-check.
mutate.renameListing({ id: "1" });

// @ts-expect-error — `id` is a string; a number must not type-check.
mutate.renameListing({ id: 1, name: "Loft" });
