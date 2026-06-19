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
 * Every stub POSTs to `/__lesto/mutations/:name`, attaches the configured CSRF token
 * on the `x-csrf-token` header (the double-submit channel 2), and ALWAYS returns the
 * discriminated result union — a non-2xx answer is mapped back into the failure arm
 * (the server already shaped it), and a transport failure surfaces as a coded
 * `MUTATION_TRANSPORT_FAILED` failure arm. So a caller writes one `if (result.ok)`
 * and never a `try/catch` around the happy path.
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
   */
  csrfToken?: string;

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
    const headers: Record<string, string> = {
      ...baseHeaders,
      "content-type": "application/json",
      ...(options.csrfToken === undefined ? {} : { [CSRF_HEADER]: options.csrfToken }),
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
