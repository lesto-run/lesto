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
  it("uses .one and interpolates count when count === 1", () => {
    expect(make().plural("en", "cart", 1)).toBe("1 item in your cart");
  });

  it("uses .other and interpolates count when count !== 1", () => {
    expect(make().plural("en", "cart", 3)).toBe("3 items in your cart");
  });

  it("merges caller params alongside count", () => {
    const i18n = new I18n({
      defaultLocale: "en",
      locales: { en: { "x.other": "{count} for {who}" } },
    });

    expect(i18n.plural("en", "x", 2, { who: "Ada" })).toBe("2 for Ada");
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
