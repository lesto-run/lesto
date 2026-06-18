/**
 * Result — the explicit success-or-failure value.
 *
 * A function that can fail returns a `Result` instead of throwing, so the
 * failure is visible in the type and the caller is forced to handle it. The
 * two arms are discriminated by `ok`, narrowable with `isOk` / `isErr`.
 */

import { VoloError } from "./errors";

export type Result<T, E = VoloError> = { ok: true; value: T } | { ok: false; error: E };

/** Wrap a value as a successful result. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Wrap an error as a failed result. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Narrow a result to its success arm. */
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/** Narrow a result to its failure arm. */
export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

/**
 * Pull the value out of a result, throwing on failure.
 *
 * If the error is already an `Error`, it is thrown as-is so its stack and type
 * survive. Otherwise it is wrapped in a `VoloError` so callers always catch an
 * `Error`, never a bare string or object.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }

  const { error } = result;

  if (error instanceof Error) {
    throw error;
  }

  throw new VoloError("UNWRAP_NON_ERROR", "Tried to unwrap a failed result.", { error });
}
