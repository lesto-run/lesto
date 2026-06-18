/**
 * @volo/i18n — internationalization core: message catalogs, interpolation,
 * pluralization. Pure, no dependencies.
 *
 *   const i18n = new I18n({ defaultLocale: "en", locales: { en, fr } });
 *   i18n.t("fr", "greeting", { name: "Ada" });
 *   i18n.plural("en", "cart.items", count);
 */

export { I18n } from "./i18n";

export { interpolate } from "./interpolate";

export type { I18nOptions, Messages, OnMissing, Params } from "./types";
