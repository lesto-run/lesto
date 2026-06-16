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

/**
 * Observability seam: notified when `t` is asked for a key that resolves
 * nowhere — not in the requested locale and not (when `fallback` is on) in the
 * default locale. Wire it to a counter to find untranslated strings in
 * production *before* a user reports a raw key on screen.
 *
 * The `locale` is the one originally requested (not the fallback), so the event
 * names the locale whose catalog is missing the entry. The hook is observational
 * — `t` still returns the key itself regardless of what the hook does.
 */
export type OnMissing = (locale: string, key: string) => void;

/** What the I18n instance needs to know to translate. */
export interface I18nOptions {
  /** Catalogs keyed by locale name (e.g. `{ en: {...}, fr: {...} }`). */
  locales: Record<string, Messages>;

  /** The locale consulted when a key is missing and `fallback` is on. */
  defaultLocale: string;

  /** Whether a missing key falls back to `defaultLocale`. Defaults to `true`. */
  fallback?: boolean;

  /**
   * Called once per `t` call whose key resolves nowhere (after fallback). A
   * missing-translation counter for production observability; see
   * {@link OnMissing}.
   */
  onMissing?: OnMissing;
}
