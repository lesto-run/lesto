/**
 * Placeholder interpolation: `{name}` → the value of `params.name`.
 *
 * A placeholder with no matching param is left verbatim — translators see the
 * literal `{name}` rather than an empty hole, which makes missing data obvious.
 */

import type { Params } from "./types";

// Matches a single `{identifier}` token; the captured group is the param name.
const PLACEHOLDER = /\{(\w+)\}/g;

export const interpolate = (template: string, params: Params): string =>
  template.replaceAll(PLACEHOLDER, (whole, name: string) => {
    // Read only OWN params: a placeholder like `{constructor}` must not resolve
    // an inherited `Object.prototype` member and dump a function into the text.
    const value = Object.hasOwn(params, name) ? params[name] : undefined;

    // Invariant: an unknown placeholder stays as written, signalling missing data.
    if (value === undefined) return whole;

    return String(value);
  });
