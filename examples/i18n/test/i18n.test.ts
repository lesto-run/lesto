/**
 * The example's QA gate: drive @lesto/i18n through the REAL HTTP routes. It
 * proves what only an end-to-end wiring can — that the SAME page renders
 * DIFFERENTLY per locale (French is not English), that a `{param}` is spliced in
 * (and left verbatim when absent), that the plural line follows each language's
 * OWN CLDR rules (French makes 0 singular; Russian splits one/few/many), that a
 * key the requested locale omits falls back to the default WITHOUT counting as a
 * miss, and that a key resolving nowhere surfaces as its own name AND fires the
 * OnMissing seam.
 *
 * Every assertion is constructed to go RED if its feature broke: the plural
 * assertions use EXACT strings (so a naive `count === 1 ? one : other` would fail
 * French's 0-is-singular and Russian's `few`), and the escaping test pairs a
 * positive "escaped form present" with a negative "raw tag absent".
 */

import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app";

/** Pull the text of a `data-<marker>`-tagged element out of the rendered page. */
function textOf(html: string, marker: string): string {
  return html.match(new RegExp(`data-${marker}[^>]*>([^<]*)<`))?.[1] ?? "";
}

/** Pull the `<li data-count>` cart lines out of the rendered page, in order. */
function cartLines(html: string): string[] {
  return [...html.matchAll(/<li data-count="\d+">([^<]*)<\/li>/g)].map((m) => m[1] ?? "");
}

/** GET a route and return its rendered HTML body. */
async function render(
  path: string,
  options?: { query?: Record<string, string>; headers?: Record<string, string> },
): Promise<string> {
  const { app } = buildApp();
  const res = await app.handle("GET", path, options ?? {});

  expect(res.status).toBe(200);

  return res.body as string;
}

describe("@lesto/i18n example — catalog lookup + interpolation", () => {
  it("interpolates the greeting from a ?name query param", async () => {
    const html = await render("/en", { query: { name: "Ada" } });
    expect(textOf(html, "greeting")).toBe("Hello, Ada!");
  });

  it("renders a DIFFERENT string for the same key in French", async () => {
    const en = textOf(await render("/en", { query: { name: "Ada" } }), "greeting");
    const fr = textOf(await render("/fr", { query: { name: "Ada" } }), "greeting");

    expect(fr).toBe("Bonjour, Ada !");
    // The point of i18n: the SAME key, a DIFFERENT rendering per locale.
    expect(fr).not.toBe(en);
  });

  it("renders the Russian greeting from the Cyrillic catalog", async () => {
    const html = await render("/ru", { query: { name: "Ada" } });
    expect(textOf(html, "greeting")).toBe("Привет, Ada!");
  });

  it("leaves the {name} placeholder verbatim when no name is given", async () => {
    const html = await render("/en");
    // interpolate leaves an unmatched placeholder as written — visible, not blank.
    expect(textOf(html, "greeting")).toBe("Hello, {name}!");
  });

  it("HTML-escapes an interpolated value (the caller's escaping duty)", async () => {
    const html = await render("/en", { query: { name: "<script>alert(1)</script>" } });

    // Positive: the value survives, escaped.
    expect(html).toContain("Hello, &lt;script&gt;alert(1)&lt;/script&gt;!");
    // Negative (guarded by the positive above, so it can't pass vacuously): the
    // live <script> tag never reaches the document.
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("@lesto/i18n example — pluralization follows each language's CLDR rules", () => {
  it("splits one/other in English (1 is singular, 0 and N are plural)", async () => {
    const [zero, one, two, five] = cartLines(await render("/en"));

    expect(zero).toBe("0 items in your cart");
    expect(one).toBe("1 item in your cart"); // `one`
    expect(two).toBe("2 items in your cart");
    expect(five).toBe("5 items in your cart");
  });

  it("treats 0 as SINGULAR in French (fr selects `one` for both 0 and 1)", async () => {
    const [zero, one, two] = cartLines(await render("/fr"));

    // The money assertion: a naive `count === 1` rule would render "0 articles"
    // here; French's own CLDR rule makes 0 singular, so it is "0 article".
    expect(zero).toBe("0 article dans votre panier");
    expect(one).toBe("1 article dans votre panier");
    expect(two).toBe("2 articles dans votre panier");
  });

  it("selects one/few/many for Russian", async () => {
    const [zero, one, two, five] = cartLines(await render("/ru"));

    expect(one).toBe("1 товар в корзине"); // one
    expect(two).toBe("2 товара в корзине"); // few
    expect(five).toBe("5 товаров в корзине"); // many
    expect(zero).toBe("0 товаров в корзине"); // many (0 in Russian)
  });
});

describe("@lesto/i18n example — fallback to the default locale", () => {
  it("shows the English tagline on the French page (fr omits `tagline`)", async () => {
    const en = textOf(await render("/en"), "tagline");
    const fr = textOf(await render("/fr"), "tagline");

    // fr has no `tagline` key, so it resolves via the default locale — a visible
    // fallback, identical to English, not a blank or a raw key.
    expect(fr).toBe(en);
    expect(fr).toBe("Everything you need, nothing you don't.");
  });

  it("a fallback hit is NOT counted as a miss", async () => {
    const { app, misses } = buildApp();

    // Rendering the French page reads fr's missing `tagline` via fallback.
    await app.handle("GET", "/fr");

    // A resolvable fallback is a feature, not a gap — the seam must stay quiet.
    expect(misses).toHaveLength(0);
  });
});

describe("@lesto/i18n example — locale selection", () => {
  it("takes the locale from the PATH segment", async () => {
    expect(textOf(await render("/fr", { query: { name: "Ada" } }), "greeting")).toBe(
      "Bonjour, Ada !",
    );
    expect(await render("/ru")).toContain('lang="ru"');
  });

  it("resolves an UNSUPPORTED path segment to the default locale", async () => {
    const html = await render("/de", { query: { name: "Ada" } });

    // `/de` has no catalog → default (en), and the declared lang matches the
    // language actually rendered (never `lang="de"` full of English).
    expect(textOf(html, "greeting")).toBe("Hello, Ada!");
    expect(html).toContain('lang="en"');
  });

  it("negotiates the locale from Accept-Language on GET /", async () => {
    const fr = await render("/", { headers: { "accept-language": "fr-CA,fr;q=0.9,en;q=0.8" } });
    expect(textOf(fr, "greeting")).toBe("Bonjour, {name} !"); // fr, no ?name

    const en = await render("/", { headers: { "accept-language": "en-US,en;q=0.9" } });
    expect(textOf(en, "greeting")).toBe("Hello, {name}!");

    const ru = await render("/", { headers: { "accept-language": "ru" } });
    expect(ru).toContain('lang="ru"');
  });

  it("honours the q-weights, not header order", async () => {
    // English is listed FIRST but weighted LOWER — French must win.
    const html = await render("/", { headers: { "accept-language": "en;q=0.3,fr;q=0.9" } });
    expect(html).toContain('lang="fr"');
  });

  it("defaults to English for an unsupported or absent Accept-Language", async () => {
    const unsupported = await render("/", { headers: { "accept-language": "de,es;q=0.8" } });
    expect(unsupported).toContain('lang="en"');

    const absent = await render("/");
    expect(absent).toContain('lang="en"');
  });
});

describe("@lesto/i18n example — the OnMissing observability seam", () => {
  it("surfaces a key that resolves NOWHERE as its own name, and logs it", async () => {
    const { i18n, misses } = buildApp();

    // `checkout.button` is in no catalog and no fallback — a genuinely missing
    // translation. It renders as the key itself (visible), never blank.
    expect(i18n.t("fr", "checkout.button")).toBe("checkout.button");

    // The seam records the miss against the REQUESTED locale (fr), not the
    // fallback (en) — so the log names the catalog that needs the entry.
    expect(misses).toEqual([{ locale: "fr", key: "checkout.button" }]);
  });

  it("falls back to the default locale for an entirely unknown locale", async () => {
    const { i18n, misses } = buildApp();

    // `de` has no catalog, but the key exists in the default (en) → a fallback
    // hit, so it renders English AND does not count as a miss.
    expect(i18n.t("de", "greeting", { name: "Ada" })).toBe("Hello, Ada!");
    expect(misses).toHaveLength(0);
  });
});
