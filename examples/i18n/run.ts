/**
 * The whole @lesto/i18n journey, in-process, in one run.
 *
 *   bun run examples/i18n/run.ts
 *
 * It boots the app (no database — translation is catalog lookup + interpolation),
 * then drives the real HTTP routes to show, side by side, the SAME page rendered
 * in three languages: the greeting interpolated, the cart line pluralized across
 * a count sweep (watch French make 0 singular and Russian split one/few/many),
 * and the French tagline arriving via fallback to English. A second leg drives
 * the `Accept-Language` negotiation, and a third shows the missing-key seam.
 */

import { buildApp, CART_COUNTS, SUPPORTED_LOCALES } from "./src/app";

/** Pull the text of a `data-<marker>`-tagged element out of the rendered page. */
function textOf(html: string, marker: string): string {
  return html.match(new RegExp(`data-${marker}[^>]*>([^<]*)<`))?.[1] ?? "";
}

/** Pull the `<li data-count>` cart lines out of the rendered page, in order. */
function cartLines(html: string): string[] {
  return [...html.matchAll(/<li data-count="\d+">([^<]*)<\/li>/g)].map((m) => m[1] ?? "");
}

async function main(): Promise<void> {
  const { app, i18n, misses } = buildApp();

  // 1. The SAME page, rendered in each locale via its PATH segment.
  console.log("── the same page, three languages (GET /:locale?name=Ada) ──\n");
  for (const locale of SUPPORTED_LOCALES) {
    const res = await app.handle("GET", `/${locale}`, { query: { name: "Ada" } });
    const html = res.body as string;

    console.log(`/${locale} -> ${res.status}`);
    console.log(`  greeting: ${textOf(html, "greeting")}`);
    console.log(`  tagline : ${textOf(html, "tagline")}`);
    console.log(`  cart    : [${CART_COUNTS.join(", ")}] items ->`);
    for (const line of cartLines(html)) console.log(`            "${line}"`);
    console.log();
  }

  // 2. The tagline the French page shows is ENGLISH — fr omits `tagline`, so it
  //    falls back to the default locale (a resolvable fallback, not a miss).
  const frPage = (await app.handle("GET", "/fr")).body as string;
  console.log("── fallback: fr has no `tagline`, so it borrows en's ──");
  console.log(
    `  fr tagline === en tagline: ${textOf(frPage, "tagline") === i18n.t("en", "tagline")}\n`,
  );

  // 3. Locale negotiated from the `Accept-Language` header (GET /, no path locale).
  console.log("── locale negotiated from Accept-Language (GET /) ──");
  const headers: Array<[string, string]> = [
    ["fr-CA,fr;q=0.9,en;q=0.8", "fr"],
    ["en-US,en;q=0.9", "en"],
    ["ru", "ru"],
    ["de", "en (unsupported → default)"],
    ["en;q=0.3,fr;q=0.9", "fr (higher q wins)"],
  ];
  for (const [accept, expected] of headers) {
    const res = await app.handle("GET", "/", { headers: { "accept-language": accept } });
    console.log(`  "${accept}" -> ${textOf(res.body as string, "greeting")}   (${expected})`);
  }
  console.log();

  // 4. Interpolation leaves a missing param's placeholder verbatim (no `?name`).
  const noName = (await app.handle("GET", "/en")).body as string;
  console.log("── interpolation: no ?name leaves the placeholder as written ──");
  console.log(`  ${textOf(noName, "greeting")}\n`);

  // 5. The missing-key seam: a key that resolves NOWHERE surfaces as its own name
  //    and fires `onMissing` — the untranslated strings a team wants to find.
  console.log("── missing keys are visible, and logged for translators ──");
  console.log(
    `  t("de", "greeting", {name:"Ada"}) -> ${i18n.t("de", "greeting", { name: "Ada" })}   (unknown locale → default)`,
  );
  const beforeMisses = misses.length;
  console.log(`  t("fr", "checkout.button") -> ${i18n.t("fr", "checkout.button")}   (visible key)`);
  console.log(`  misses logged by that lookup: ${JSON.stringify(misses.slice(beforeMisses))}`);
}

await main();
