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

import type { I18nOptions, Messages, OnMissing, Params } from "./types";

/**
 * Read `key` from a catalog only if it is the catalog's OWN property.
 *
 * A plain object inherits members from `Object.prototype` (`constructor`,
 * `toString`, …). A bare bracket read would resolve those inherited functions
 * for a key like `"constructor"`, leaking the prototype chain and handing
 * `interpolate` a non-string. `Object.hasOwn` confines the lookup to real
 * translations; an absent or proto-only key resolves to a miss.
 */
function own(catalog: Messages | undefined, key: string): string | undefined {
  if (catalog === undefined) return undefined;

  return Object.hasOwn(catalog, key) ? catalog[key] : undefined;
}

export class I18n {
  /** Catalogs keyed by locale; named `catalogs` so `locales()` can be a method. */
  private readonly catalogs: Record<string, Messages>;

  private readonly defaultLocale: string;

  private readonly fallback: boolean;

  private readonly onMissing: OnMissing | undefined;

  constructor(options: I18nOptions) {
    this.catalogs = options.locales;
    this.defaultLocale = options.defaultLocale;
    this.fallback = options.fallback ?? true;
    this.onMissing = options.onMissing;
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
    if (template === undefined) {
      // Observability seam: count the miss against the *requested* locale, then
      // fall through to the visible key. A throwing counter must not break a
      // translation, so its rejection is swallowed.
      this.reportMissing(locale, key);

      return key;
    }

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

  /** Fire the missing-key counter, swallowing a throw so `t` stays total. */
  private reportMissing(locale: string, key: string): void {
    if (this.onMissing === undefined) return;

    try {
      this.onMissing(locale, key);
    } catch {
      // A broken counter must not break translation — see {@link OnMissing}.
    }
  }

  /** Resolve `key`'s template, consulting the default locale when allowed. */
  private lookup(locale: string, key: string): string | undefined {
    const direct = own(this.catalogs[locale], key);

    if (direct !== undefined) return direct;

    if (!this.fallback) return undefined;

    return own(this.catalogs[this.defaultLocale], key);
  }
}
