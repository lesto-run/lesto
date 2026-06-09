/**
 * @keel/i18n — message catalogs with interpolation and pluralization.
 *
 *   const i18n = new I18n({
 *     defaultLocale: "en",
 *     locales: {
 *       en: { hello: "Hello, {name}!", "cart.one": "{count} item", "cart.other": "{count} items" },
 *       fr: { hello: "Bonjour, {name} !" },
 *     },
 *   });
 *
 *   i18n.t("fr", "hello", { name: "Ada" });   // "Bonjour, Ada !"
 *   i18n.t("fr", "cart.one");                  // falls back to en
 *   i18n.plural("en", "cart", 1);              // "1 item"
 *   i18n.plural("en", "cart", 3);              // "3 items"
 */

import { interpolate } from "./interpolate";

import type { I18nOptions, Messages, Params } from "./types";

export class I18n {
  /** Catalogs keyed by locale; named `catalogs` so `locales()` can be a method. */
  private readonly catalogs: Record<string, Messages>;

  private readonly defaultLocale: string;

  private readonly fallback: boolean;

  constructor(options: I18nOptions) {
    this.catalogs = options.locales;
    this.defaultLocale = options.defaultLocale;
    this.fallback = options.fallback ?? true;
  }

  /**
   * Translate `key` in `locale`, interpolating `params`.
   *
   * Lookup order: the requested locale, then — if `fallback` is on — the
   * default locale. A key absent from both resolves to the key itself, so a
   * missing translation is visible rather than blank.
   */
  t(locale: string, key: string, params: Params = {}): string {
    const template = this.lookup(locale, key);

    // Invariant: an unknown key surfaces as its own name, never an empty string.
    if (template === undefined) return key;

    return interpolate(template, params);
  }

  /**
   * Translate a pluralized `key` by `count`.
   *
   * Picks `key.one` when `count === 1`, otherwise `key.other`, and threads
   * `count` into the params so the chosen template can render it.
   */
  plural(locale: string, key: string, count: number, params: Params = {}): string {
    const suffix = count === 1 ? "one" : "other";

    return this.t(locale, `${key}.${suffix}`, { ...params, count });
  }

  /** Whether `key` resolves in `locale` (honouring fallback). */
  has(locale: string, key: string): boolean {
    return this.lookup(locale, key) !== undefined;
  }

  /** The locale names known to this instance. */
  locales(): string[] {
    return Object.keys(this.catalogs);
  }

  // -- internals ------------------------------------------------------------

  /** Resolve `key`'s template, consulting the default locale when allowed. */
  private lookup(locale: string, key: string): string | undefined {
    const direct = this.catalogs[locale]?.[key];

    if (direct !== undefined) return direct;

    if (!this.fallback) return undefined;

    return this.catalogs[this.defaultLocale]?.[key];
  }
}
