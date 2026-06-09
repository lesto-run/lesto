/**
 * Shared shapes for @keel/i18n.
 */

/**
 * A catalog for a single locale: a flat map from key to message template.
 *
 * Templates use `{placeholder}` syntax; placeholders are filled from `params`
 * at translation time. Keys are dotted by convention for pluralization
 * (`cart.items.one`, `cart.items.other`), but the catalog itself is flat.
 */
export type Messages = Record<string, string>;

/** Values an interpolation placeholder can take. */
export type Params = Record<string, string | number>;

/** What the I18n instance needs to know to translate. */
export interface I18nOptions {
  /** Catalogs keyed by locale name (e.g. `{ en: {...}, fr: {...} }`). */
  locales: Record<string, Messages>;

  /** The locale consulted when a key is missing and `fallback` is on. */
  defaultLocale: string;

  /** Whether a missing key falls back to `defaultLocale`. Defaults to `true`. */
  fallback?: boolean;
}
