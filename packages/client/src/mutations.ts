/**
 * `createMutationClient` — the typed CALL side of Lesto's server mutations (ADR 0022).
 *
 * The server defines mutations with `@lesto/runtime`'s `defineMutation`; this builds
 * the browser-safe stub map that calls them with end-to-end inferred types — no
 * codegen, the `createApi`/`ApiContract` trick applied to mutations:
 *
 *   import type { MutationContractOf } from "@lesto/runtime";
 *   type Mutations = MutationContractOf<typeof serverMutations>;   // inferred
 *
 *   const mutate = createMutationClient<Mutations>({ csrfToken });
 *
 *   const result = await mutate.renameListing({ id, name });       // arg typed
 *   if (result.ok) use(result.data.listing);                       // data typed
 *   else show(result.error.code);                                  // typed error path
 *
 * Every stub POSTs to `/__lesto/mutations/:name`, attaches the CSRF token on the
 * `x-csrf-token` header (the double-submit channel 2), and ALWAYS returns the
 * discriminated result union — a non-2xx answer is mapped back into the failure arm
 * (the server already shaped it), and a transport failure surfaces as a coded
 * `MUTATION_TRANSPORT_FAILED` failure arm. So a caller writes one `if (result.ok)`
 * and never a `try/catch` around the happy path.
 *
 * The CSRF token can be supplied two ways: an explicit `csrfToken` (the caller
 * already holds it), or `fetchCsrfToken` — the INTERNALIZED round-trip, where the
 * client fetches the token itself on first use and caches it so a form stops
 * re-fetching CSRF per submit (the explicit token wins when both are given).
 *
 * Browser-safe by construction: native `fetch`, no Node deps. The server module's
 * VALUES never cross — only its contract TYPE, which is erased at runtime.
 */

import { wrapFetch } from "@lesto/observability";

import { defaultOrigin, defaultSpanId } from "./client";
import type { TraceContext } from "./client";

/** The single endpoint every mutation is dispatched through (mirrors `@lesto/runtime`). */
export const MUTATION_ROUTE_PREFIX = "/__lesto/mutations";

/** The header the CSRF token rides on — the double-submit channel 2 (matches `@lesto/csrf`). */
const CSRF_HEADER = "x-csrf-token";

/**
 * The wire shape of one mutation in a contract: its parsed `input` and its `output`.
 * `MutationContractOf<typeof defs>` (from `@lesto/runtime`) projects a server
 * mutation map to a `Record<name, MutationSpec>`, so the client types are the
 * server's own — declared once, shared by import (no codegen).
 */
export interface MutationSpec {
  input: unknown;

  output: unknown;
}

/** A mutation contract: name → its {@link MutationSpec}. */
export type MutationContract = Record<string, MutationSpec>;

/** The discriminated result union a stub resolves to — the typed error path is a value. */
export type MutationResult<Output> =
  | { ok: true; data: Output }
  | { ok: false; error: { code: string; message: string } };

/**
 * The typed stub surface: one method per mutation, taking that mutation's `input`
 * and resolving to its {@link MutationResult}. The input argument is OPTIONAL only
 * when the schema accepts `undefined` (a no-arg mutation), REQUIRED otherwise — a
 * tuple so a no-arg call needs no argument at all.
 */
export type MutationClient<C extends MutationContract> = {
  [K in keyof C]: (
    ...args: undefined extends C[K]["input"] ? [input?: C[K]["input"]] : [input: C[K]["input"]]
  ) => Promise<MutationResult<C[K]["output"]>>;
};

/** What `createMutationClient` accepts. */
export interface MutationClientOptions {
  /** Prepended to the mutation endpoint. Default `""` (same-origin). */
  baseUrl?: string;

  /**
   * The double-submit CSRF token the page read from its companion cookie. Sent on
   * the `x-csrf-token` header of every call, so the server's `verifyToken` check
   * passes. Omit only when no token-based CSRF guard is configured server-side.
   *
   * When BOTH this and {@link fetchCsrfToken} are given, this explicit token wins
   * (the round-trip is never made) — so wiring an internal fetch never silently
   * overrides a token the caller already holds.
   */
  csrfToken?: string;

  /**
   * Fetch the double-submit CSRF token from the server — the INTERNALIZED round-trip.
   *
   * Without this, a form has to fetch its CSRF token itself (a `GET /…/csrf`), keep
   * it in component state, and thread it into `csrfToken` on every submit. Give a
   * `fetchCsrfToken` instead and the client owns that: it runs the fetch LAZILY on
   * the first call that needs a token and CACHES the resulting promise, so any
   * number of concurrent or later submits share a single round-trip — the form
   * stops re-implementing CSRF per submit.
   *
   * A rejecting `fetchCsrfToken` is NOT thrown: the call resolves to a coded
   * `MUTATION_CSRF_FETCH_FAILED` failure arm (the same one-`if` contract as every
   * other failure), and the cache is cleared so a later submit retries the fetch.
   *
   * Ignored when {@link csrfToken} is set (the explicit token wins). Omit both when
   * no token-based CSRF guard is configured server-side.
   */
  fetchCsrfToken?: () => Promise<string>;

  /** Headers sent on every call (e.g. an auth token), overridable by the CSRF header. */
  headers?: Record<string, string>;

  /** The `fetch` implementation — defaults to the global. Injected for tests/edge. */
  fetch?: typeof fetch;

  /**
   * The browser trace context to propagate (ARCHITECTURE.md §7). When set, the
   * stub's `fetch` is wrapped so a same-origin mutation carries an outbound
   * `traceparent` continuing the page's trace — the server handler joins the SAME
   * trace the page's RUM spans belong to. Absent → the plain fetch.
   */
  trace?: TraceContext;
}

/** Read a response body as JSON, or `undefined` when it is empty / not JSON. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  if (text === "") return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** True iff `value` is already a well-formed mutation result union (server-shaped). */
function isResult(value: unknown): value is MutationResult<unknown> {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;

  const ok = (value as { ok: unknown }).ok;

  if (ok === true) return "data" in value;

  if (ok === false) {
    const error = (value as { error?: unknown }).error;

    return (
      typeof error === "object" &&
      error !== null &&
      typeof (error as { code?: unknown }).code === "string"
    );
  }

  return false;
}

/**
 * Build a typed mutation client over a contract `C`.
 *
 * Returns a `Proxy` whose every property is a stub: the property name IS the
 * mutation name, so adding a server mutation adds a client method with no new code.
 * Each stub POSTs the input as JSON to `/__lesto/mutations/:name`, threads the CSRF
 * token, and resolves the result union — mapping a malformed/transport answer into
 * a coded failure arm so the call never throws on the happy path.
 */
export function createMutationClient<C extends MutationContract>(
  options: MutationClientOptions = {},
): MutationClient<C> {
  const baseUrl = options.baseUrl ?? "";
  const baseHeaders = options.headers ?? {};

  // The internalized CSRF round-trip (item 2). When `fetchCsrfToken` is given (and
  // no explicit `csrfToken` overrides it), the FIRST call that needs a token runs
  // the fetch and caches the in-flight promise here, so concurrent and later
  // submits share one round-trip instead of each re-fetching. A rejected fetch is
  // surfaced as a coded failure arm by the caller and the cache is cleared, so a
  // later submit retries rather than being wedged on a dead promise forever.
  let csrfTokenPromise: Promise<string> | undefined;

  const resolveCsrfToken = (fetchToken: () => Promise<string>): Promise<string> => {
    // Cache the in-flight promise on first use so concurrent and later submits
    // SHARE one round-trip. The rejection is NOT normalized here — `call` owns the
    // single failure site (it clears this cache and maps to a coded failure arm),
    // so there is exactly one place the reject becomes a result and no dead branch.
    csrfTokenPromise ??= fetchToken();

    return csrfTokenPromise;
  };

  // When a trace context is configured, wrap `fetch` so a same-origin mutation
  // carries an outbound `traceparent` continuing the page's trace — identical to
  // `createApi`'s propagation. Absent → the bare configured fetch.
  const fetchImpl =
    options.trace === undefined
      ? (options.fetch ?? fetch)
      : wrapFetch({
          traceId: options.trace.traceId,
          origin: options.trace.origin ?? defaultOrigin(),
          randomSpanId: options.trace.randomSpanId ?? defaultSpanId,
          fetchImpl: options.fetch ?? fetch,
        });

  const call = async (name: string, input: unknown): Promise<MutationResult<unknown>> => {
    // Resolve the CSRF token: the explicit `csrfToken` wins; otherwise the
    // internalized `fetchCsrfToken` round-trip (cached, shared across calls); else
    // none (no token-based guard configured). A failed internal fetch is mapped to
    // a coded failure arm here so the one-`if` contract holds and the call never
    // throws on the CSRF path.
    let csrfToken = options.csrfToken;

    if (csrfToken === undefined && options.fetchCsrfToken !== undefined) {
      try {
        csrfToken = await resolveCsrfToken(options.fetchCsrfToken);
      } catch (cause) {
        // The internal CSRF fetch failed — clear the cached promise so a LATER
        // submit retries (rather than being wedged on a dead promise forever), and
        // surface a coded failure arm so the caller's one `if` covers it too.
        csrfTokenPromise = undefined;

        return {
          ok: false,
          error: {
            code: "MUTATION_CSRF_FETCH_FAILED",
            message: cause instanceof Error ? cause.message : "CSRF token fetch failed.",
          },
        };
      }
    }

    const headers: Record<string, string> = {
      ...baseHeaders,
      "content-type": "application/json",
      ...(csrfToken === undefined ? {} : { [CSRF_HEADER]: csrfToken }),
    };

    let response: Response;

    try {
      response = await fetchImpl(`${baseUrl}${MUTATION_ROUTE_PREFIX}/${encodeURIComponent(name)}`, {
        method: "POST",
        headers,
        body: JSON.stringify(input ?? null),
      });
    } catch (cause) {
      // The fetch itself never resolved (network down, aborted) — a transport
      // failure, surfaced as the failure arm so the caller's one `if` covers it.
      return {
        ok: false,
        error: {
          code: "MUTATION_TRANSPORT_FAILED",
          message: cause instanceof Error ? cause.message : "Mutation request failed.",
        },
      };
    }

    const body = await readJson(response);

    // The server shapes BOTH arms as the result union (with a matching status), so a
    // well-formed body is returned verbatim — including a non-2xx failure arm.
    if (isResult(body)) return body;

    // A non-JSON / malformed answer (a proxy 502 page, say) — coerce to a coded
    // transport failure rather than handing back an unknown shape.
    return {
      ok: false,
      error: {
        code: "MUTATION_TRANSPORT_FAILED",
        message: `Mutation "${name}" returned an unexpected response (${response.status}).`,
      },
    };
  };

  return new Proxy({} as MutationClient<C>, {
    get(_target, prop: string | symbol) {
      // A symbol access (a thenable check, `Symbol.toPrimitive`) is never a
      // mutation name — return undefined so the proxy is not mistaken for a thenable.
      if (typeof prop !== "string") return undefined;

      return (input?: unknown) => call(prop, input);
    },
  });
}
