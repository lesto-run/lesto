/**
 * examples/i18n — the @lesto/i18n journey behind real HTTP routes.
 *
 * A tiny shop front rendered in three languages, so every piece of the battery
 * shows up at the HTTP boundary:
 *
 *   - CATALOG LOOKUP — a page title + tagline pulled from a per-locale catalog;
 *   - {param} INTERPOLATION — a greeting that splices a `?name=` into the string
 *     (and, with no `?name`, leaves the `{name}` placeholder verbatim — the
 *     interpolate contract);
 *   - PLURALIZATION — a cart line rendered across a count sweep, where the CLDR
 *     category is chosen by `Intl.PluralRules`, so English splits one/other,
 *     FRENCH treats 0 as singular, and RUSSIAN spans one/few/many;
 *   - FALLBACK — the French catalog omits `tagline`, so the French page shows the
 *     English tagline (a resolvable key via the default locale is NOT a miss);
 *   - the OnMissing SEAM — a key that resolves nowhere surfaces as its own name
 *     (visible, never blank) and fires the observability hook this app wires to a
 *     `misses` log the test inspects.
 *
 * LOCALE SELECTION is shown BOTH ways the web offers it:
 *
 *   GET /            the locale is NEGOTIATED from the `Accept-Language` header
 *                    (weighted, `fr-CA` → the `fr` catalog), defaulting to `en`;
 *   GET /:locale     the locale is taken from the PATH segment (`/fr`, `/ru`),
 *                    resolving an unsupported segment to the default so the page
 *                    always renders in a language the catalog actually has.
 *
 * Only `@lesto/i18n`'s public API is used for translation (`I18n`, its `t` /
 * `plural` methods, and the `Messages` type); the routes are plain `@lesto/web`.
 * There is no database — translation is catalog lookup + interpolation, nothing
 * more (`serve.ts` opens a throwaway handle only to satisfy the kernel contract).
 */

import { I18n } from "@lesto/i18n";
import type { Messages } from "@lesto/i18n";
import { lesto } from "@lesto/web";
import type { Lesto } from "@lesto/web";

/**
 * The English catalog — the default locale, and the fallback every other locale
 * leans on for a key it has not translated yet.
 */
const en: Messages = {
  "page.title": "The Lesto Shop",
  greeting: "Hello, {name}!",
  tagline: "Everything you need, nothing you don't.",
  "cart.one": "{count} item in your cart",
  "cart.other": "{count} items in your cart",
};

/**
 * The French catalog. `tagline` is deliberately ABSENT — a real half-translated
 * catalog — so the French page falls back to the English tagline, proving a
 * fallback hit is a visible feature, not a miss.
 */
const fr: Messages = {
  "page.title": "La Boutique Lesto",
  greeting: "Bonjour, {name} !",
  "cart.one": "{count} article dans votre panier",
  "cart.other": "{count} articles dans votre panier",
};

/**
 * The Russian catalog. Russian needs THREE plural forms — `one` (1, 21, …),
 * `few` (2–4, …), and `many` (0, 5–20, …) — which `Intl.PluralRules` selects for
 * us; the catalog need only spell the categories the language uses.
 */
const ru: Messages = {
  "page.title": "Магазин Lesto",
  greeting: "Привет, {name}!",
  tagline: "Всё, что нужно, и ничего лишнего.",
  "cart.one": "{count} товар в корзине",
  "cart.few": "{count} товара в корзине",
  "cart.many": "{count} товаров в корзине",
};

/** The locales this app ships catalogs for; the FIRST is the default/fallback. */
export const SUPPORTED_LOCALES = ["en", "fr", "ru"] as const;

/** A locale this app can actually render — one of {@link SUPPORTED_LOCALES}. */
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** The locale consulted for a key another locale has not translated. */
const DEFAULT_LOCALE: SupportedLocale = "en";

/** The counts the cart line is rendered across, to show the plural rules diverge. */
export const CART_COUNTS = [0, 1, 2, 5] as const;

/** Narrow a raw string to a {@link SupportedLocale}. */
function isSupported(locale: string): locale is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale);
}

/**
 * Resolve a PATH-segment locale to one this app ships, defaulting when unknown.
 *
 * An unsupported segment (`/de`) resolves to the default rather than rendering a
 * `<html lang="de">` full of English — the page's declared language always
 * matches the language it is actually written in.
 */
export function resolveLocale(segment: string): SupportedLocale {
  return isSupported(segment) ? segment : DEFAULT_LOCALE;
}

/**
 * Pick the best supported locale from an `Accept-Language` header.
 *
 * The header is a weighted list (`fr-CA,fr;q=0.9,en;q=0.8`): we order its tags by
 * `q` (default weight 1) and return the first whose PRIMARY subtag this app ships
 * a catalog for, so `fr-CA` matches the `fr` catalog. With no header, no parsable
 * weight, or nothing supported, it resolves to the default — the page always
 * renders in a language the catalog has.
 */
export function negotiateLocale(acceptLanguage: string | undefined): SupportedLocale {
  if (acceptLanguage === undefined) return DEFAULT_LOCALE;

  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const weight = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const q = weight === undefined ? 1 : Number.parseFloat(weight.slice(2));

      return { tag: tag.trim().toLowerCase(), q: Number.isNaN(q) ? 0 : q };
    })
    .filter((entry) => entry.tag !== "")
    .toSorted((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const primary = tag.split("-")[0] ?? "";
    if (isSupported(primary)) return primary;
  }

  return DEFAULT_LOCALE;
}

/**
 * HTML-escape a translated string before it enters the document.
 *
 * `@lesto/i18n`'s interpolation is PLAIN TEXT by contract (see the package's
 * `interpolate` doc): it splices params in verbatim and does NO markup encoding,
 * leaving the sink's correct escaping to the renderer. `name` is attacker-
 * controlled (a query param) and a template could equally carry markup, so every
 * translated string is escaped HERE — the caller's job, exactly as documented.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Render the localized shop page.
 *
 * `name` is optional: given, it interpolates the greeting; omitted, the greeting
 * is translated with NO params, so `@lesto/i18n` leaves the `{name}` placeholder
 * verbatim — the "missing data is visible, not blank" contract, on show.
 */
function shopPage(i18n: I18n, locale: SupportedLocale, name: string | undefined): string {
  const title = escapeHtml(i18n.t(locale, "page.title"));
  const greeting = escapeHtml(
    name === undefined ? i18n.t(locale, "greeting") : i18n.t(locale, "greeting", { name }),
  );
  const tagline = escapeHtml(i18n.t(locale, "tagline"));

  const cart = CART_COUNTS.map(
    (count) => `<li data-count="${count}">${escapeHtml(i18n.plural(locale, "cart", count))}</li>`,
  ).join("");

  const query = name === undefined ? "" : `?name=${encodeURIComponent(name)}`;
  const nav = SUPPORTED_LOCALES.map((loc) =>
    loc === locale
      ? `<strong data-current="${loc}">${loc}</strong>`
      : `<a href="/${loc}${query}">${loc}</a>`,
  ).join(" · ");

  return (
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">` +
    `<title>${title}</title></head><body>` +
    `<h1 data-greeting>${greeting}</h1>` +
    `<p data-tagline>${tagline}</p>` +
    `<ul data-cart>${cart}</ul>` +
    `<nav>${nav}</nav>` +
    `</body></html>`
  );
}

/** One missing-key event, as the OnMissing seam reports it. */
export interface MissEvent {
  readonly locale: string;
  readonly key: string;
}

/** The dependencies the routes close over. */
export interface I18nAppDeps {
  readonly i18n: I18n;
}

/**
 * The routes, closing over the shared {@link I18n} instance.
 *
 *   GET /          shop page; locale NEGOTIATED from `Accept-Language`
 *   GET /:locale   shop page; locale taken from the PATH segment
 */
export function buildI18nApp(deps: I18nAppDeps): Lesto {
  const { i18n } = deps;

  return lesto()
    .get("/", (c) =>
      c.html(shopPage(i18n, negotiateLocale(c.header("accept-language")), c.query("name"))),
    )
    .get("/:locale", (c) =>
      c.html(shopPage(i18n, resolveLocale(c.param("locale")), c.query("name"))),
    );
}

/** What `buildApp` returns: the app plus the handles run.ts / the test inspect. */
export interface Booted {
  readonly app: Lesto;

  /** The shared translator, exposed so the test can drive `t`/`plural` directly. */
  readonly i18n: I18n;

  /** Every key that resolved nowhere, as the OnMissing seam logged it. */
  readonly misses: readonly MissEvent[];
}

/**
 * Boot the i18n app: build the three-locale {@link I18n} (wiring `onMissing` to a
 * `misses` log for observability), wire the routes, and hand back the pieces.
 *
 * No database — translation is catalog lookup + interpolation. The English
 * catalog is the default locale, so any locale's untranslated key falls back to
 * it (a resolvable fallback is not a miss; only a key absent EVERYWHERE is).
 */
export function buildApp(): Booted {
  const misses: MissEvent[] = [];

  const i18n = new I18n({
    defaultLocale: DEFAULT_LOCALE,
    locales: { en, fr, ru },
    onMissing: (locale, key) => {
      // Production observability seam: a key that resolves in NEITHER the
      // requested locale NOR the default lands here — the untranslated strings a
      // team wants to find before a user sees a raw key on screen.
      misses.push({ locale, key });
    },
  });

  return { app: buildI18nApp({ i18n }), i18n, misses };
}
