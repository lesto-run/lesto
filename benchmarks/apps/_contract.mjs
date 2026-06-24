/**
 * The single source of truth for the workload response bodies (see
 * `../workloads.md`). Every Node/Bun app imports these so the bytes are defined
 * once — if an app's framework renderer emits anything else, the parity check
 * fails and the run is void.
 */

/** The exact `/plaintext` body. */
export const plaintextBody = "Hello, World!";

/** The exact `/json` body (compact, no whitespace). */
export const jsonObject = { message: "Hello, World!" };
export const jsonBody = JSON.stringify(jsonObject);

/** How many rows the SSR workload renders. */
export const SSR_ROWS = 50;

/** The inner row list — the part a framework's SSR renderer must produce. */
export function ssrRows(rows = SSR_ROWS) {
  let out = "";
  for (let i = 0; i < rows; i += 1) {
    out += `<div class="row"><span class="cell">item ${i}</span></div>`;
  }

  return out;
}

/** Wrap rendered body markup in the minimal document shell the contract requires. */
export function htmlDocument(body) {
  return `<!doctype html><html><head><title>Bench</title></head><body>${body}</body></html>`;
}

/** The exact, full `/ssr` body. */
export function ssrBody(rows = SSR_ROWS) {
  return htmlDocument(`<div class="box">${ssrRows(rows)}</div>`);
}

// ---------------------------------------------------------------------------
// `/realistic` — a credible e-commerce SSR page (vs the TechEmpower hello-worlds).
//
// Per the Platformatic "corrected results" SSR benchmark, plaintext/JSON/50-row
// pages flatter raw routers and hide what a real fullstack request costs. This
// workload mirrors a personalized catalog page: a non-trivial product grid that is
// re-rendered every request (NO response caching) behind a simulated 1–5 ms DB
// round-trip. The latency floor and the body are defined HERE so every app incurs
// the IDENTICAL I/O wait and emits byte-identical bytes — the comparison is then
// the framework's overhead + async behaviour under that wait, nothing else.
// ---------------------------------------------------------------------------

/** How many product cards the realistic catalog page renders. */
export const REALISTIC_PRODUCTS = 24;

/**
 * A deterministic product derived purely from its index — no randomness, no clock,
 * so the rendered page is byte-identical across every framework and every run.
 * `toFixed` is spec-deterministic, so the formatted price/rating are stable too.
 */
export function realisticProduct(i) {
  const id = 1000 + i;

  return {
    id,
    name: `Trading Card No. ${id}`,
    price: (4.99 + i * 2.5).toFixed(2),
    rating: (3 + (i % 20) / 10).toFixed(1),
    reviews: i * 7 + 3,
  };
}

/** Render one product card — a single line, no whitespace between tags (byte-stable). */
export function realisticCard(p) {
  return (
    `<li class="card" data-id="${p.id}">` +
    `<a class="thumb" href="/p/${p.id}"><img src="/img/${p.id}.webp" alt="${p.name}" width="220" height="308" loading="lazy"></a>` +
    `<h3 class="title"><a href="/p/${p.id}">${p.name}</a></h3>` +
    `<div class="meta"><span class="price">$${p.price}</span><span class="rating" aria-label="${p.rating} out of 5">${p.rating}★</span></div>` +
    `<p class="reviews">${p.reviews} reviews</p>` +
    `<button class="add" type="button" data-id="${p.id}">Add to cart</button>` +
    `</li>`
  );
}

/**
 * The exact, full `/realistic` body: a complete catalog document (head with meta +
 * stylesheet link, site header/nav/search, a grid of {@link REALISTIC_PRODUCTS}
 * cards, footer). A single line — no newlines, no indentation — like `ssrBody`.
 * Rebuilt on every call so apps can re-render per request (the no-caching rule).
 */
export function realisticBody(count = REALISTIC_PRODUCTS) {
  let cards = "";
  for (let i = 0; i < count; i += 1) {
    cards += realisticCard(realisticProduct(i));
  }

  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Trading Cards — CardMarket</title><link rel="stylesheet" href="/assets/app.css">` +
    `</head><body>` +
    `<header class="site"><a class="logo" href="/">CardMarket</a>` +
    `<nav class="nav"><a href="/cards">Cards</a><a href="/sealed">Sealed</a><a href="/decks">Decks</a><a href="/account">Account</a></nav>` +
    `<form class="search" action="/search" method="get"><input name="q" type="search" placeholder="Search cards"><button type="submit">Search</button></form>` +
    `</header>` +
    `<main class="catalog"><h1>Trading Cards</h1><ul class="grid">${cards}</ul></main>` +
    `<footer class="site"><p>© CardMarket — showing ${count} of 12,480 results</p></footer>` +
    `</body></html>`
  );
}

/**
 * Simulate one uncached database round-trip for the realistic page: a 1–5 ms async
 * wait, drawn per call. Defined here so EVERY app shares the identical latency model
 * (fairness), and awaited PER REQUEST (never memoised) to mirror a personalized page
 * that can't be cached. The per-request jitter averages out across a load run, so it
 * doesn't inflate the trial-to-trial CV the driver's stability gate watches.
 */
export function simulateDbLatency() {
  const ms = 1 + Math.floor(Math.random() * 5); // 1..5 ms

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
