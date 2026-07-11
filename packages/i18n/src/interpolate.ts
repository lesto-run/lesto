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
 *
 * {@link interpolateHtml} is the HTML-sink variant: same placeholder rules,
 * but both the template and every interpolated value are HTML-escaped, for
 * the common case where the sink IS an HTML document.
 */

import { escapeHtml } from "./html";

import type { Params } from "./types";

// Matches a single `{identifier}` token; the captured group is the param name.
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Shared substitution pass: locate every `{identifier}` in `template` and
 * replace it with `encode(String(value))`, leaving an unmatched placeholder
 * verbatim. `interpolate` and `interpolateHtml` differ ONLY in `encode` —
 * identity for plain text, {@link escapeHtml} for the HTML sink — so the
 * placeholder-matching and missing-param rules live in exactly one place.
 */
function substitute(template: string, params: Params, encode: (raw: string) => string): string {
  return template.replaceAll(PLACEHOLDER, (whole, name: string) => {
    // Read only OWN params: a placeholder like `{constructor}` must not resolve
    // an inherited `Object.prototype` member and dump a function into the text.
    const value = Object.hasOwn(params, name) ? params[name] : undefined;

    // Invariant: an unknown placeholder stays as written, signalling missing data.
    if (value === undefined) return whole;

    return encode(String(value));
  });
}

export const interpolate = (template: string, params: Params): string =>
  substitute(template, params, (value) => value);

/**
 * HTML-safe interpolation: escapes BOTH `template`'s literal text and every
 * interpolated param, then splices — the result is safe to write directly
 * into an HTML document, even when the template itself carries markup (a
 * compromised or careless catalog entry) or a param is attacker-controlled.
 *
 * The template is escaped FIRST, before placeholders are located. `escapeHtml`
 * never touches `{`, `}`, or word characters, so every `{name}` token survives
 * that pass unchanged and {@link PLACEHOLDER} still finds it; only the
 * surrounding literal text (and, per-match, the substituted value) is encoded.
 */
export const interpolateHtml = (template: string, params: Params): string =>
  substitute(escapeHtml(template), params, escapeHtml);
