/**
 * @lesto/i18n — internationalization core: message catalogs, interpolation,
 * pluralization. Pure, no dependencies.
 *
 *   const i18n = new I18n({ defaultLocale: "en", locales: { en, fr } });
 *   i18n.t("fr", "greeting", { name: "Ada" });
 *   i18n.plural("en", "cart.items", count);
 *
 * `t`/`plural`/`interpolate` return PLAIN TEXT by contract — writing that
 * straight into HTML is a footgun (a translation or param becomes markup).
 * `tHtml`/`pluralHtml`/`interpolateHtml` are the HTML-safe variants: same
 * lookup rules, but the template and every interpolated param are HTML-escaped
 * before splicing, so the result is safe to write directly into a document.
 *
 *   i18n.tHtml("fr", "greeting", { name: userSuppliedName }); // escaped
 */

export { I18n } from "./i18n";

export { escapeHtml } from "./html";
export { interpolate, interpolateHtml } from "./interpolate";

export type { I18nOptions, Messages, OnMissing, Params } from "./types";
