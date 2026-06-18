/**
 * @volo/i18n — message catalogs with interpolation and pluralization.
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
 *
 * Pluralization is **locale-correct**: the category for `count` is chosen by the
 * platform's `Intl.PluralRules` (zero-dep, present on Node and Workers), so
 * `fr` treats 0 as singular, `ru`/`pl` distinguish `few`/`many`, and `ar` spans
 * all six categories. A catalog need only supply the categories its language
 * uses (`one`/`other` for English); `other` is the universal fallback, so a
 * catalog keyed only by the bare/`other` key keeps working unchanged.
 */

import { interpolate } from "./interpolate";

import type { I18nOptions, Messages, OnMissing, Params } from "./types";

/**
 * The CLDR plural categories, in resolution order. `other` is mandatory in
 * every language and is the fallback when a catalog omits the category that
 * `Intl.PluralRules` selected — so a single `key.other` entry always resolves.
 */
type PluralCategory = Intl.LDMLPluralRule;

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

  /**
   * Memoized `Intl.PluralRules` per locale. Constructing the rules object parses
   * CLDR data, so a hot `plural` loop builds it once per locale rather than once
   * per call. `null` records a locale whose tag `Intl` rejected, so the failed
   * construction is attempted only once.
   */
  private readonly pluralRules = new Map<string, Intl.PluralRules | null>();

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
   * The CLDR category for `count` is chosen by the locale's `Intl.PluralRules`
   * (so `fr` makes 0 singular, `ru`/`pl` split `few`/`many`, `ar` uses all six),
   * then resolved to a catalog suffix by {@link pluralSuffix}. `count` is threaded
   * into the params so the chosen template can render it.
   */
  plural(locale: string, key: string, count: number, params: Params = {}): string {
    return this.t(locale, `${key}.${this.pluralSuffix(locale, key, count)}`, { ...params, count });
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

  /**
   * The catalog suffix to render `key` at `count` in `locale`.
   *
   * Plural categories are per-language, so resolution PREFERS the requested
   * locale's own forms: the category `Intl.PluralRules` selected, then its
   * universal `other`. This keeps a half-translated catalog (one that spells only
   * `key.other`) in its own language instead of borrowing the default locale's
   * exact-category form — the bleed `count === 1` would otherwise cause when the
   * default locale spells `one` and the requested locale does not. Only when the
   * requested locale spells NEITHER form does it defer to the default locale, and
   * then it re-selects the category by the *default* locale's rules, so the
   * borrowed string is itself grammatical (English `count === 1` renders `one`,
   * never `other`). With nothing resolvable it collapses to `other` — the
   * category CLDR guarantees everywhere — so `t` surfaces the `key.other` miss a
   * translator should add first.
   */
  private pluralSuffix(locale: string, key: string, count: number): PluralCategory {
    const spelled = (loc: string, category: PluralCategory): boolean =>
      own(this.catalogs[loc], `${key}.${category}`) !== undefined;

    const category = this.pluralCategory(locale, count);

    if (spelled(locale, category)) return category;
    if (spelled(locale, "other")) return "other";

    // The requested locale spells neither form. If fallback can reach the default
    // locale, pick the category by ITS rules so the borrowed plural is correct.
    if (this.fallback && locale !== this.defaultLocale) {
      const fallbackCategory = this.pluralCategory(this.defaultLocale, count);

      if (spelled(this.defaultLocale, fallbackCategory)) return fallbackCategory;
    }

    return "other";
  }

  /**
   * The CLDR plural category `Intl.PluralRules` assigns to `count` in `locale`.
   *
   * The rules object is memoized per locale. A locale tag that `Intl` cannot
   * parse (a structurally invalid BCP-47 string) throws on construction; rather
   * than break a translation, the failure is recorded as `null` and the count
   * resolves to `other` — the universal category — keeping `plural` total like
   * `t`.
   */
  private pluralCategory(locale: string, count: number): PluralCategory {
    const rules = this.rulesFor(locale);

    return rules === null ? "other" : rules.select(count);
  }

  /** Build-or-fetch the cached `Intl.PluralRules` for `locale`; `null` if its tag is invalid. */
  private rulesFor(locale: string): Intl.PluralRules | null {
    const cached = this.pluralRules.get(locale);

    if (cached !== undefined) return cached;

    let rules: Intl.PluralRules | null;
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      // An unparseable locale tag is a developer error, not runtime data — a
      // pluralization must not throw, so it degrades to the `other` category.
      rules = null;
    }

    this.pluralRules.set(locale, rules);

    return rules;
  }

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
