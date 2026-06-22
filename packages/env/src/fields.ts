/**
 * Field validators — one per environment-variable type.
 *
 * An env var arrives as a string or not at all, so each field's job is small and
 * total: turn a raw `string | undefined` into a typed value, or say why it cannot.
 * Coercion is deliberately env-correct — `number`/`port` parse, `oneOf` pins a
 * literal union, and `boolean` reads the usual words WITHOUT the `Boolean("false")
 * === true` footgun that `z.coerce.boolean()` ships. Relax a field with `.optional()`
 * (value may be `undefined`) or `.default(v)` (a fallback when unset).
 */

import { EnvError } from "./errors";

/** The raw env source: a bag of string values keyed by name (`process.env`-shaped). */
export type EnvSource = Record<string, string | undefined>;

/** A field's parse outcome — a typed value, or a human reason it was rejected. */
type Coerced = { ok: true; value: unknown } | { ok: false; error: string };

/** How a present (non-empty) raw value becomes a typed value. */
type Coerce = (raw: string) => Coerced;

/** What a field does when its var is unset: require it, default it, or allow `undefined`. */
type Fallback = { kind: "default"; value: unknown } | { kind: "optional" } | undefined;

/**
 * One environment variable's validator. `T` is the type it yields once validated;
 * the runtime is untyped (`T` is a phantom carried for inference). Immutable:
 * `optional()`/`default()` return NEW fields, so a shared base spec is never mutated.
 */
export class EnvField<T> {
  constructor(
    private readonly coerce: Coerce,
    private readonly fallback: Fallback = undefined,
  ) {}

  /** Allow the var to be unset — its value is then `undefined`. */
  optional(): EnvField<T | undefined> {
    return new EnvField<T | undefined>(this.coerce, { kind: "optional" });
  }

  /**
   * Use `value` when the var is unset (or empty).
   *
   * The default is validated the SAME way a present value is — by re-coercing its
   * string form — so an invalid default (`port().default(70000)`,
   * `number().default(NaN)`) throws a coded {@link EnvError} as the schema is built,
   * not silently slips an invalid value into a "validated" env. (TS already rejects a
   * wrong-TYPED default; this catches a right-typed but out-of-range one.)
   */
  default(value: T): EnvField<T> {
    const check = this.coerce(String(value));

    if (!check.ok) {
      throw new EnvError(
        "ENV_INVALID_DEFAULT",
        `default value ${JSON.stringify(value)} is invalid: ${check.error}`,
        { value, reason: check.error },
      );
    }

    return new EnvField<T>(this.coerce, { kind: "default", value });
  }

  /** Validate one raw value (the var's `source` entry) into `T`, or report why not. */
  parse(raw: string | undefined): { ok: true; value: T } | { ok: false; error: string } {
    // An unset OR empty var is "missing": the repo treats `""` as unset everywhere
    // (a placeholder that resolved to empty is the same as never having been set).
    if (raw === undefined || raw === "") {
      if (this.fallback === undefined) return { ok: false, error: "is required but not set" };

      if (this.fallback.kind === "default") return { ok: true, value: this.fallback.value as T };

      return { ok: true, value: undefined as T };
    }

    const result = this.coerce(raw);

    return result.ok ? { ok: true, value: result.value as T } : result;
  }
}

/** The words a `boolean` field reads as true / false (case-insensitive, trimmed). */
const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

/** The smallest / largest TCP port a `port` field accepts. */
const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * The field builders — one per env type. Each yields a REQUIRED field; chain
 * `.optional()` or `.default(v)` to relax it. Named `envField` (not `env`) so it
 * never collides with the `const env = defineEnv(...)` a caller writes.
 */
export const envField = {
  /** A non-empty string, verbatim. */
  string(): EnvField<string> {
    return new EnvField<string>((raw) => ({ ok: true, value: raw }));
  },

  /** A finite number (`"3000"` → `3000`, `"3.14"` → `3.14`). */
  number(): EnvField<number> {
    return new EnvField<number>((raw) => {
      const value = Number(raw);

      return Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, error: "must be a number" };
    });
  },

  /** A TCP port — an integer from 1 to 65535. */
  port(): EnvField<number> {
    return new EnvField<number>((raw) => {
      const value = Number(raw);

      return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT
        ? { ok: true, value }
        : { ok: false, error: `must be a port (an integer from ${MIN_PORT} to ${MAX_PORT})` };
    });
  },

  /** A boolean from the usual words: `true/1/yes/on` vs `false/0/no/off` (case-insensitive). */
  boolean(): EnvField<boolean> {
    return new EnvField<boolean>((raw) => {
      const word = raw.trim().toLowerCase();

      if (TRUE_WORDS.has(word)) return { ok: true, value: true };

      if (FALSE_WORDS.has(word)) return { ok: true, value: false };

      return { ok: false, error: "must be a boolean (true/false, 1/0, yes/no, on/off)" };
    });
  },

  /** One of a fixed set — yields the literal union of the allowed values. */
  oneOf<const V extends string>(values: readonly V[]): EnvField<V> {
    return new EnvField<V>((raw) =>
      values.includes(raw as V)
        ? { ok: true, value: raw }
        : { ok: false, error: `must be one of: ${values.join(", ")}` },
    );
  },
};
