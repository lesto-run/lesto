---
"@lesto/i18n": minor
---

Add HTML-safe translation helpers so rendering a translation into markup can't XSS.

`t()` / `interpolate()` are plain-text by contract — the caller must HTML-escape before rendering into HTML, or a translation (or an interpolated param) becomes stored/reflected XSS. That contract is unchanged, but the common "render `t(...)` into HTML" path was an easy-to-forget footgun. New escape-by-default siblings:

- `escapeHtml(value)` — escape a single string.
- `interpolateHtml(template, params)` — escapes the template and every interpolated param.
- `I18n.tHtml(...)` / `I18n.pluralHtml(...)` — the HTML-safe analogues of `t` / `plural`, same lookup/fallback/pluralization rules with escaping applied (including the surfaced missing-key).

The plain-text `t` / `plural` / `interpolate` return byte-for-byte the same output as before — the sink still decides the encoding; these just make the safe choice the easy one.
