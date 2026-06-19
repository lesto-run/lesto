/**
 * Typed server mutations — the non-RSC server-action / typed-RPC seam (ADR 0022).
 *
 * A **mutation** is a named, Zod-validated, CSRF-guarded server handler that
 * returns a typed result. Define it once on the server; call it from an island
 * with the argument AND return types inferred end to end — no codegen, no RSC
 * transform. This module is the DEFINE side and the BOUNDARY; `@lesto/client`'s
 * `createMutationClient` is the typed call side, and the two share only a contract
 * *type* (erased at runtime), exactly as `createApi`/`ApiContract` do.
 *
 *   const rename = defineMutation({
 *     name: "renameListing",
 *     input: z.object({ id: z.string(), name: z.string().trim().min(1) }),
 *     handler: async (input, c) => ({ listing: await store.rename(input.id, input.name) }),
 *   });
 *
 *   app.route(mutationRoutes({ renameListing: rename }, { csrf }));
 *
 * The boundary, per call, in order: resolve by `:name` (unknown → 404), CSRF check
 * (reusing `@lesto/csrf`'s `verifyToken`, never re-implemented), Zod parse (ADR
 * 0005), dispatch, then serialize a discriminated result union — so the typed
 * error path is a value, never a throw. Every gate is fail-closed.
 */

import { assertStrongSecret, verifyToken } from "@lesto/csrf";
import { lesto } from "@lesto/web";
import type { Context, Lesto, LestoRequest, LestoResponse } from "@lesto/web";
import type { ZodType } from "zod";

import { MutationError } from "./errors";

/** The single endpoint every mutation is dispatched through (the `:name` selects it). */
export const MUTATION_ROUTE_PREFIX = "/__lesto/mutations";

/** The header the client presents the double-submit CSRF token on (matches `@lesto/csrf`). */
const CSRF_HEADER = "x-csrf-token";

const NOT_FOUND = 404;
const FORBIDDEN = 403;
const UNPROCESSABLE = 422;
const BAD_REQUEST = 400;

/**
 * One mutation's typed contract. The `Input`/`Output` parameters live ONLY in the
 * phantom carriers `__input`/`__output` — never in `input`/`handler`, which are
 * ERASED to `unknown` (the one-erasure-boundary precedent `defineIsland` sets).
 *
 * That erasure is what lets a heterogeneous `{ a: Mutation<A,_>, b: Mutation<B,_> }`
 * map satisfy `MutationMap` despite a handler being CONTRAVARIANT in its input — a
 * `Mutation<A>` and a `Mutation<B>` share one erased runtime shape, while the
 * phantoms keep the precise types for {@link MutationContractOf} to read. So the
 * types cross the network with no codegen and no `any`.
 */
export interface Mutation<Input = unknown, Output = unknown> {
  /** The name the `:name` segment selects this mutation by. */
  readonly name: string;

  /** The Zod schema the boundary parses the request body with (ADR 0005) — erased. */
  readonly input: ZodType<unknown>;

  /** The handler, run only on a parsed (trusted) input; its return is the `data` — erased. */
  readonly handler: (input: unknown, c: Context) => unknown;

  /** Phantom carriers so `typeof mutation` exposes `Input`/`Output` to the client contract. */
  readonly __input?: Input;
  readonly __output?: Output;
}

/** What {@link defineMutation} accepts — `name` + Zod `input` + a typed `handler`. */
export interface MutationDef<Input, Output> {
  readonly name: string;

  readonly input: ZodType<Input>;

  readonly handler: (input: Input, c: Context) => Output | Promise<Output>;
}

/**
 * Define a typed server mutation.
 *
 * `Input` is inferred from the Zod schema (the parsed type) and `Output` from the
 * handler's return — so a `defineMutation` map's `typeof` carries every mutation's
 * exact wire types in its phantoms. `handler` receives the PARSED input (validation
 * already ran at the boundary; it never re-validates) and the request {@link Context}.
 *
 * The erased `Mutation` shape is produced by one cast at this boundary — the same
 * precedent `defineIsland` uses, because a precise handler is contravariant in its
 * input and so not directly assignable to the erased one.
 */
export function defineMutation<Input, Output>(
  def: MutationDef<Input, Output>,
): Mutation<Input, Output> {
  return { name: def.name, input: def.input, handler: def.handler } as unknown as Mutation<
    Input,
    Output
  >;
}

/** A map of name → mutation — what `mutationRoutes` mounts and the client contract derives from. */
export type MutationMap = Record<string, Mutation>;

/**
 * The wire contract a {@link MutationMap}'s `typeof` projects to — `{ name: { input;
 * output } }`, read off each mutation's phantom carriers. `@lesto/client`'s
 * `createMutationClient<MutationContractOf<typeof defs>>()` builds its typed stubs
 * from this, so the server definitions are the single source of truth and the
 * client cannot drift (no codegen, the `ApiContract` trick applied to mutations).
 */
export type MutationContractOf<M extends MutationMap> = {
  [K in keyof M]: {
    input: M[K] extends Mutation<infer I, infer _O> ? I : never;
    output: M[K] extends Mutation<infer _I, infer O> ? O : never;
  };
};

/** The discriminated result union the boundary serializes — the typed error path is a value. */
export type MutationResult<Output> =
  | { ok: true; data: Output }
  | { ok: false; error: { code: string; message: string } };

/**
 * How the boundary performs the CSRF check. Mirrors `@lesto/csrf`'s middleware
 * options (the same `verifyToken` runs): the app names where its session lives and
 * supplies the secret. OMIT this only when another layer already guards
 * state-changing requests app-wide (the `originCheck` companion in `secureStack`).
 */
export interface MutationCsrfOptions {
  /** The server-held secret the token signatures are computed under. */
  readonly secret: string;

  /** The session (or anon) id the presented token must be bound to — app-specific. */
  readonly sessionFor: (request: LestoRequest) => string;

  /**
   * The token the client presented, or `undefined` when none was found. Defaults
   * to the `x-csrf-token` header (what `createMutationClient` sends).
   */
  readonly extractToken?: (request: LestoRequest) => string | undefined;
}

/** What {@link mutationRoutes} accepts. */
export interface MutationRoutesOptions {
  /**
   * The CSRF guard. Present → every call is `verifyToken`-checked (fail-closed: a
   * missing token is a 403). Absent → no token check here (rely on `originCheck`
   * upstream). Opt-in by configuration, exactly as the `@lesto/csrf` middleware is.
   */
  readonly csrf?: MutationCsrfOptions;
}

/** Pull the presented CSRF token from the request — the `x-csrf-token` header by default. */
function defaultExtractToken(request: LestoRequest): string | undefined {
  const header = request.headers[CSRF_HEADER];

  return header !== undefined && header.length > 0 ? header : undefined;
}

/** Shape a coded failure into the result union's failure arm + its HTTP status. */
function failure(c: Context, status: number, code: string, message: string): LestoResponse {
  return c.json({ ok: false, error: { code, message } } satisfies MutationResult<never>, status);
}

/**
 * Run the CSRF gate, returning a refusal response when it fails or `undefined`
 * when it passes (or is not configured). Fail-closed: a missing token is as fatal
 * as a forged one. The check IS `@lesto/csrf`'s `verifyToken` — imported, never
 * re-implemented (ADR 0022).
 */
function csrfRefusal(c: Context, csrf: MutationCsrfOptions | undefined): LestoResponse | undefined {
  if (csrf === undefined) return undefined;

  const extract = csrf.extractToken ?? defaultExtractToken;
  const token = extract(c.req);

  const ok = token !== undefined && verifyToken(token, csrf.sessionFor(c.req), csrf.secret);

  return ok
    ? undefined
    : failure(c, FORBIDDEN, "MUTATION_CSRF_FAILED", "CSRF check failed for this mutation.");
}

/** Read a positive integer `status` off a `MutationError`'s details, defaulting to 400. */
function statusOf(error: MutationError): number {
  const status = error.details["status"];

  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : BAD_REQUEST;
}

/**
 * Mount a {@link MutationMap} as a `@lesto/web` sub-app: one
 * `POST /__lesto/mutations/:name` route that resolves the mutation, runs the
 * boundary (CSRF → Zod → dispatch), and answers a {@link MutationResult}.
 *
 * One endpoint, not N: adding a mutation never adds a route string. Returns a
 * `lesto()` app to `.route()` into the parent (so the parent's middleware +
 * layouts wrap it like any sub-app).
 */
export function mutationRoutes(map: MutationMap, options: MutationRoutesOptions = {}): Lesto {
  // A forgeable secret defeats the whole CSRF guard. Refuse it loud at wire time
  // (CSRF_WEAK_SECRET), exactly as the `csrf()` middleware does — `verifyToken` is
  // total and would otherwise validate against a weak secret as if healthy.
  if (options.csrf !== undefined) assertStrongSecret(options.csrf.secret);

  return lesto().post(`${MUTATION_ROUTE_PREFIX}/:name`, async (c) => {
    const name = c.param("name");
    // Own-property lookup only: a bare `map[name]` walks the prototype chain, so a
    // `:name` of `__proto__`/`constructor`/`toString` would resolve a truthy inherited
    // member, slip past the not-found guard, and throw on `.input` — an unauthenticated
    // 500 before the CSRF gate. `Object.hasOwn` confines resolution to real mutations.
    const mutation = Object.hasOwn(map, name) ? map[name] : undefined;

    // 1 · Resolve by name. An unknown name is a normal not-found, answered before
    // any CSRF or side effect — a typed error body, never a stack.
    if (mutation === undefined) {
      return failure(c, NOT_FOUND, "MUTATION_NOT_FOUND", `No mutation named "${name}".`);
    }

    // 2 · CSRF (reused from @lesto/csrf). Fail-closed when configured.
    const refused = csrfRefusal(c, options.csrf);
    if (refused !== undefined) return refused;

    // 3 · Zod parse (ADR 0005). The handler never sees an unvalidated body.
    const parsed = mutation.input.safeParse(c.req.body);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: { code: "MUTATION_INVALID_INPUT", message: "Mutation input failed validation." },
        } satisfies MutationResult<never>,
        UNPROCESSABLE,
      );
    }

    // 4 · Dispatch + 5 · serialize the discriminated union.
    try {
      const data = await mutation.handler(parsed.data, c);

      return c.json({ ok: true, data } satisfies MutationResult<unknown>);
    } catch (error) {
      // A handler's deliberate domain refusal takes the typed failure arm with its
      // chosen status; any other throw is a bug — re-raise to the app's boundary
      // (a 500), never leaked as a typed error.
      if (error instanceof MutationError) {
        return failure(c, statusOf(error), error.code, error.message);
      }

      throw error;
    }
  });
}
