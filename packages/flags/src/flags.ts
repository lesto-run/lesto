/**
 * Feature flags — declared, evaluated per request, and gated as middleware.
 *
 * `defineFlags({ defaults, resolve })` yields `enabled(flag, c)` and a `gate(...)`
 * middleware. A `gate` hides a route or a whole subtree when a flag is off — by
 * default a 404, so an off feature simply does not exist to a client, rather than
 * 403-advertising its presence. Like the authorization guard, it is a plain
 * middleware: `.use(gate("new-ui"))` on a sub-router guards every route and page
 * beneath it, or `gate(...)` inline on a single API route.
 *
 * Evaluation order is dynamic-then-static: a `resolve(flag, c)` is consulted first
 * (a per-user rollout, a tenant override, a query-string toggle in dev), and a
 * `defaults` map answers when it returns `undefined`. An undeclared flag with no
 * default is off — the safe default, same spirit as the policy's deny-by-default.
 */

import type { AnyVoloResponse, Context, Handler } from "@volo/web";

/** How flags are declared and resolved. */
export interface FlagsConfig {
  /** Static on/off defaults, consulted when `resolve` does not decide. */
  defaults?: Readonly<Record<string, boolean>>;

  /**
   * A dynamic resolver consulted before `defaults` — return a boolean to decide,
   * or `undefined` to defer to the static default. This is where a per-user or
   * per-tenant rollout lives.
   */
  resolve?: (flag: string, c: Context) => boolean | undefined;

  /** Build the response for a gated-off flag. Defaults to a plain 404. */
  onDisabled?: (c: Context, flag: string) => AnyVoloResponse;
}

/** A flag set bound to its evaluation strategy — the enforcement surface. */
export interface Flags {
  /** Is `flag` on for this request? */
  enabled(flag: string, c: Context): boolean;

  /** Middleware that hides the route unless every named flag is on. */
  gate(...flags: string[]): Handler;
}

const notFound = (): AnyVoloResponse => ({
  status: 404,
  headers: { "content-type": "text/plain" },
  body: "Not Found",
});

/** Build a {@link Flags} from its declaration. */
export function defineFlags(config: FlagsConfig = {}): Flags {
  const defaults = config.defaults ?? {};
  const onDisabled = config.onDisabled ?? notFound;

  const enabled = (flag: string, c: Context): boolean => {
    const dynamic = config.resolve?.(flag, c);

    // A dynamic decision wins.
    if (dynamic !== undefined) return dynamic;

    // Otherwise the static default; otherwise off. The lookup is own-property
    // only: a flag named after an inherited Object member ("toString",
    // "constructor", "__proto__") must read as off, not as that truthy member —
    // off-by-default is the invariant.
    return Object.hasOwn(defaults, flag) && defaults[flag] === true;
  };

  return {
    enabled,

    gate(...flags: string[]): Handler {
      return (c, next) => {
        for (const flag of flags) {
          if (!enabled(flag, c)) return onDisabled(c, flag);
        }

        return next();
      };
    },
  };
}
