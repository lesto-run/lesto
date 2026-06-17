import { describe, expect, it, vi } from "vitest";

import { I18n, interpolate } from "../src/index";

import type { Messages } from "../src/index";

const en: Messages = {
  greeting: "Hello, {name}!",
  plain: "Just text.",
  "cart.one": "{count} item in your cart",
  "cart.other": "{count} items in your cart",
};

const fr: Messages = {
  greeting: "Bonjour, {name} !",
  // No `plain` key here — exercises the fallback path into `en`.
};

const make = (fallback?: boolean): I18n =>
  new I18n({
    defaultLocale: "en",
    locales: { en, fr },
    ...(fallback === undefined ? {} : { fallback }),
  });

describe("I18n.t", () => {
  it("interpolates placeholders from params", () => {
    expect(make().t("en", "greeting", { name: "Ada" })).toBe("Hello, Ada!");
  });

  it("leaves a missing param's placeholder as written", () => {
    expect(make().t("en", "greeting")).toBe("Hello, {name}!");
  });

  it("returns a key present in the requested locale", () => {
    expect(make().t("fr", "greeting", { name: "Ada" })).toBe("Bonjour, Ada !");
  });

  it("falls back to the default locale when the key is missing", () => {
    expect(make().t("fr", "plain")).toBe("Just text.");
  });

  it("returns the key itself when it is missing everywhere", () => {
    expect(make().t("en", "nope")).toBe("nope");
  });

  it("does not consult the default locale when fallback is off", () => {
    expect(make(false).t("fr", "plain")).toBe("plain");
  });

  it("returns the key for an entirely unknown locale", () => {
    expect(make().t("de", "greeting")).toBe("Hello, {name}!");
  });

  it("returns the key for an unknown locale when fallback is off", () => {
    expect(make(false).t("de", "greeting")).toBe("greeting");
  });

  it("treats inherited Object.prototype members as misses, not translations", () => {
    // A catalog is a plain object, so `constructor`/`toString` live on its
    // prototype. Looking up such a key must surface the key itself — never the
    // inherited function (which would leak the prototype chain into the output).
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(make().t("en", key)).toBe(key);
      expect(make().has("en", key)).toBe(false);
    }
  });

  it("treats inherited members as misses even with fallback off", () => {
    expect(make(false).t("fr", "toString")).toBe("toString");
  });
});

describe("I18n.plural", () => {
  it("uses .one and interpolates count when English selects `one`", () => {
    expect(make().plural("en", "cart", 1)).toBe("1 item in your cart");
  });

  it("uses .other and interpolates count when English selects `other`", () => {
    expect(make().plural("en", "cart", 3)).toBe("3 items in your cart");
  });

  it("uses .other for zero in English (English has no `zero` category)", () => {
    expect(make().plural("en", "cart", 0)).toBe("0 items in your cart");
  });

  it("merges caller params alongside count", () => {
    const i18n = new I18n({
      defaultLocale: "en",
      locales: { en: { "x.other": "{count} for {who}" } },
    });

    expect(i18n.plural("en", "x", 2, { who: "Ada" })).toBe("2 for Ada");
  });

  // -- locale-correct categories (Intl.PluralRules) -------------------------

  it("treats 0 as singular in French (fr selects `one` for 0 and 1)", () => {
    const i18n = new I18n({
      defaultLocale: "en",
      locales: {
        en: { "cart.one": "{count} item", "cart.other": "{count} items" },
        fr: { "cart.one": "{count} article", "cart.other": "{count} articles" },
      },
    });

    expect(i18n.plural("fr", "cart", 0)).toBe("0 article");
    expect(i18n.plural("fr", "cart", 1)).toBe("1 article");
    expect(i18n.plural("fr", "cart", 2)).toBe("2 articles");
  });

  it("selects one/few/many for Russian", () => {
    const ru: Messages = {
      "file.one": "{count} файл",
      "file.few": "{count} файла",
      "file.many": "{count} файлов",
    };
    const i18n = new I18n({ defaultLocale: "ru", locales: { ru } });

    expect(i18n.plural("ru", "file", 1)).toBe("1 файл"); // one
    expect(i18n.plural("ru", "file", 2)).toBe("2 файла"); // few
    expect(i18n.plural("ru", "file", 5)).toBe("5 файлов"); // many
    expect(i18n.plural("ru", "file", 21)).toBe("21 файл"); // one (21)
    expect(i18n.plural("ru", "file", 0)).toBe("0 файлов"); // many (0)
  });

  it("selects one/few/many for Polish", () => {
    const pl: Messages = {
      "item.one": "{count} element",
      "item.few": "{count} elementy",
      "item.many": "{count} elementów",
    };
    const i18n = new I18n({ defaultLocale: "pl", locales: { pl } });

    expect(i18n.plural("pl", "item", 1)).toBe("1 element"); // one
    expect(i18n.plural("pl", "item", 2)).toBe("2 elementy"); // few
    expect(i18n.plural("pl", "item", 5)).toBe("5 elementów"); // many
    expect(i18n.plural("pl", "item", 22)).toBe("22 elementy"); // few (22)
  });

  it("selects all six categories for Arabic", () => {
    const ar: Messages = {
      "day.zero": "صفر أيام",
      "day.one": "يوم واحد",
      "day.two": "يومان",
      "day.few": "{count} أيام",
      "day.many": "{count} يوماً",
      "day.other": "{count} يوم",
    };
    const i18n = new I18n({ defaultLocale: "ar", locales: { ar } });

    expect(i18n.plural("ar", "day", 0)).toBe("صفر أيام"); // zero
    expect(i18n.plural("ar", "day", 1)).toBe("يوم واحد"); // one
    expect(i18n.plural("ar", "day", 2)).toBe("يومان"); // two
    expect(i18n.plural("ar", "day", 3)).toBe("3 أيام"); // few
    expect(i18n.plural("ar", "day", 11)).toBe("11 يوماً"); // many
    expect(i18n.plural("ar", "day", 100)).toBe("100 يوم"); // other
  });

  // -- `other` fallback for omitted categories ------------------------------

  it("falls back to .other when the selected category is absent from the catalog", () => {
    // Russian selects `few` for 2, but the catalog only spells `other`; the
    // bare-language catalog must keep working.
    const i18n = new I18n({
      defaultLocale: "ru",
      locales: { ru: { "file.other": "{count} файлов" } },
    });

    expect(i18n.plural("ru", "file", 2)).toBe("2 файлов");
  });

  it("surfaces the .other key when the selected category resolves nowhere", () => {
    const i18n = new I18n({ defaultLocale: "ar", locales: { ar: {} } });

    // 2 selects `two` in Arabic, but with neither `two` nor `other` in the
    // catalog the selection collapses to the universal `other`, so the visible
    // miss names `day.other` — the key a translator should add first.
    expect(i18n.plural("ar", "day", 2)).toBe("day.other");
  });

  it("surfaces the selected-category key when it is present but renders the bare key", () => {
    // When the selected category DOES resolve (no `other` collapse), the
    // selected suffix is kept — here `two` exists, so 2 renders it.
    const i18n = new I18n({
      defaultLocale: "ar",
      locales: { ar: { "day.two": "يومان" } },
    });

    expect(i18n.plural("ar", "day", 2)).toBe("يومان");
  });

  // -- robustness: malformed locale tag -------------------------------------

  it("degrades to the `other` category for a locale tag Intl cannot parse", () => {
    // A structurally invalid BCP-47 tag throws inside Intl.PluralRules; plural
    // must stay total and resolve `other` rather than propagate the RangeError.
    const i18n = new I18n({
      defaultLocale: "not a locale",
      locales: { "not a locale": { "cart.other": "{count} items" } },
    });

    expect(i18n.plural("not a locale", "cart", 1)).toBe("1 items");
  });

  it("memoizes the rules per locale across repeated calls", () => {
    const i18n = new I18n({
      defaultLocale: "en",
      locales: { en: { "cart.one": "{count} item", "cart.other": "{count} items" } },
    });

    // Two calls exercise the cache-hit branch (second call returns the memoized
    // rules) as well as the malformed-tag cache-hit on repeat.
    expect(i18n.plural("en", "cart", 1)).toBe("1 item");
    expect(i18n.plural("en", "cart", 2)).toBe("2 items");
  });

  // -- requested-locale cohesion (no default-locale plural bleed) -----------

  it("renders the requested locale's own `other` rather than the default locale's exact-category form", () => {
    // fr selects `one` for count 1, but this fr catalog spells only `cart.other`.
    // The default (en) DOES spell `cart.one`, so a fallback-aware probe would
    // borrow the English singular ("1 item") into a French page. Resolution must
    // instead stay in French and use fr's own `other`.
    const i18n = new I18n({
      defaultLocale: "en",
      locales: {
        en: { "cart.one": "{count} item", "cart.other": "{count} items" },
        fr: { "cart.other": "{count} articles" },
      },
    });

    expect(i18n.plural("fr", "cart", 1)).toBe("1 articles");
  });

  it("borrows the default locale's CORRECT category when the requested locale spells neither form", () => {
    // fr has no `cart.*` at all → defer to en, selecting the category by EN's
    // rules so the borrowed English plural is grammatical (`one`, not `other`).
    const i18n = new I18n({
      defaultLocale: "en",
      locales: {
        en: { "cart.one": "{count} item", "cart.other": "{count} items" },
        fr: {},
      },
    });

    expect(i18n.plural("fr", "cart", 1)).toBe("1 item");
    expect(i18n.plural("fr", "cart", 3)).toBe("3 items");
  });

  it("collapses to `other` when neither the requested nor the default locale spells the key", () => {
    const i18n = new I18n({ defaultLocale: "en", locales: { en: {}, fr: {} } });

    expect(i18n.plural("fr", "cart", 1)).toBe("cart.other");
  });

  it("does not consult the default locale for a plural when fallback is off", () => {
    // ru selects `many` for 5; this catalog spells only `one`, fallback is off,
    // so resolution collapses to ru's `other` and surfaces the visible miss
    // rather than reaching across to a default locale.
    const i18n = new I18n({
      defaultLocale: "en",
      fallback: false,
      locales: { ru: { "file.one": "{count} файл" } },
    });

    expect(i18n.plural("ru", "file", 5)).toBe("file.other");
  });
});

describe("I18n.has", () => {
  it("is true for a resolvable key", () => {
    expect(make().has("fr", "plain")).toBe(true);
  });

  it("is false for an unresolvable key", () => {
    expect(make().has("en", "nope")).toBe(false);
  });
});

describe("I18n.locales", () => {
  it("lists the known locale names", () => {
    expect(make().locales()).toEqual(["en", "fr"]);
  });
});

describe("I18n.onMissing", () => {
  const withHook = (onMissing: (locale: string, key: string) => void): I18n =>
    new I18n({ defaultLocale: "en", locales: { en, fr }, onMissing });

  it("fires once with the requested locale and key when a key resolves nowhere", () => {
    const missing: Array<[string, string]> = [];
    const i18n = withHook((locale, key) => {
      missing.push([locale, key]);
    });

    expect(i18n.t("fr", "nope")).toBe("nope");
    // The *requested* locale (fr), not the fallback (en), names the gap.
    expect(missing).toEqual([["fr", "nope"]]);
  });

  it("does not fire when the key is present in the requested locale", () => {
    const onMissing = vi.fn();
    expect(withHook(onMissing).t("fr", "greeting", { name: "Ada" })).toBe("Bonjour, Ada !");
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("does not fire when the key resolves only via fallback", () => {
    const onMissing = vi.fn();
    // `plain` is missing in fr but present in en — a fallback hit, not a miss.
    expect(withHook(onMissing).t("fr", "plain")).toBe("Just text.");
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("fires when fallback is off and the key is absent from the requested locale", () => {
    const missing: Array<[string, string]> = [];
    const i18n = new I18n({
      defaultLocale: "en",
      locales: { en, fr },
      fallback: false,
      onMissing: (locale, key) => {
        missing.push([locale, key]);
      },
    });

    expect(i18n.t("fr", "plain")).toBe("plain");
    expect(missing).toEqual([["fr", "plain"]]);
  });

  it("fires for a missing pluralized key, carrying the category-suffixed key", () => {
    const missing: Array<[string, string]> = [];
    const i18n = new I18n({
      defaultLocale: "en",
      locales: { en: {} },
      onMissing: (locale, key) => {
        missing.push([locale, key]);
      },
    });

    expect(i18n.plural("en", "cart", 2)).toBe("cart.other");
    expect(missing).toEqual([["en", "cart.other"]]);
  });

  it("is not fired by has() — a predicate must not log a miss", () => {
    const onMissing = vi.fn();
    expect(withHook(onMissing).has("en", "nope")).toBe(false);
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("swallows a throwing hook so t still returns the visible key", () => {
    const i18n = withHook(() => {
      throw new Error("counter exploded");
    });

    expect(i18n.t("en", "nope")).toBe("nope");
  });

  it("translates normally when no onMissing hook is configured", () => {
    expect(make().t("en", "nope")).toBe("nope");
  });
});

describe("interpolate", () => {
  it("renders numeric values as strings", () => {
    expect(interpolate("n={n}", { n: 7 })).toBe("n=7");
  });

  it("leaves a placeholder naming an inherited member as written, not the prototype value", () => {
    // `{constructor}` must not resolve `Object.prototype.constructor` and dump a
    // function into the text; with no own `constructor` param it stays verbatim.
    expect(interpolate("x={constructor}", {})).toBe("x={constructor}");
    expect(interpolate("x={toString}", {})).toBe("x={toString}");
  });
});
