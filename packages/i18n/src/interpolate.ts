/**
 * Placeholder interpolation: `{name}` → the value of `params.name`.
 *
 * A placeholder with no matching param is left verbatim — translators see the
 * literal `{name}` rather than an empty hole, which makes missing data obvious.
 *
 * Output is **plain text**: param values are stringified and spliced in as-is,
 * with no HTML/attribute/URL encoding. Both the translation template and the
 * interpolated params are untrusted from a markup standpoint, so the caller
 * MUST escape this string at the render layer (e.g. HTML-escape before writing
 * it into a document). This module deliberately does no escaping — the correct
 * encoding depends on the sink (HTML body vs. attribute vs. URL), which only the
 * renderer knows.
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
