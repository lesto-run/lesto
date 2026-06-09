import { describe, expect, it } from "vitest";

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
