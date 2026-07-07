# examples/i18n — message catalogs, interpolation, and pluralization over HTTP

Wires **`@lesto/i18n`** behind real HTTP routes to show every piece of the battery
that only makes sense end-to-end: a single page rendered in **three languages**,
with the locale chosen either from the URL or from the browser's own
`Accept-Language` header, a greeting **interpolated** from a query param, and a
cart line **pluralized** by each language's own CLDR rules — so English splits
`one`/`other`, **French makes 0 singular**, and **Russian** spans
`one`/`few`/`many`. It also shows the two behaviors a production app leans on: a
key the requested locale hasn't translated **falls back** to the default, and a
key that resolves nowhere surfaces **as its own name** while firing the
`onMissing` observability seam.

## What it shows

A tiny shop front. The catalog for each locale is plain data (`Messages` — a flat
`Record<string, string>`); one `I18n` instance renders it.

| Route         | Behavior                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`       | Shop page; the locale is **negotiated from `Accept-Language`** (weighted; `fr-CA` matches the `fr` catalog), defaulting to `en`. |
| `GET /:locale` | Shop page; the locale is taken from the **path segment** (`/fr`, `/ru`); an unsupported segment resolves to the default.        |

Each page renders:

- **catalog lookup** — the page title + tagline (`i18n.t(locale, "page.title")`);
- **`{param}` interpolation** — `GET /fr?name=Ada` → `Bonjour, Ada !`; with no
  `?name`, the `{name}` placeholder is left **verbatim** (the interpolate
  contract: missing data is visible, not blank);
- **pluralization** — the cart line across a count sweep `[0, 1, 2, 5]`, where the
  CLDR category for `count` is chosen by `Intl.PluralRules` (zero-dep, on Node and
  Workers alike). Watch the forms diverge:

  | count | `en`                    | `fr` (0 is singular)         | `ru` (one/few/many)      |
  | ----- | ----------------------- | ---------------------------- | ------------------------ |
  | 0     | 0 items in your cart    | **0 article** dans…          | 0 товар**ов** в корзине  |
  | 1     | **1 item** in your cart | 1 article dans…              | 1 товар в корзине        |
  | 2     | 2 items in your cart    | 2 article**s** dans…         | 2 товар**а** в корзине   |
  | 5     | 5 items in your cart    | 5 articles dans…             | 5 товар**ов** в корзине  |

- **fallback** — the French catalog deliberately **omits** `tagline`, so the
  French page shows the English tagline; a resolvable fallback is a feature, not a
  miss.

Only `@lesto/i18n`'s public API is used for translation: the `I18n` class (`t`,
`plural`), and the `Messages` type. The routes are plain `@lesto/web`; the locale
is read from the context with `c.param("locale")`, `c.header("accept-language")`,
and `c.query("name")`. There is no database — translation is catalog lookup +
interpolation.

Every translated string is **HTML-escaped at the render layer** before it enters
the document. `@lesto/i18n`'s interpolation is plain text by contract — it splices
params in verbatim and does no markup encoding, because only the renderer knows
the sink (HTML body vs. attribute vs. URL). `name` is attacker-controlled, so
escaping is the app's job, and the test proves a `<script>` payload is neutralized.

## How to run

```bash
bun run examples/i18n/run.ts
```

Boots the app and drives the routes in-process: it prints the same page in all
three languages side by side (greeting, tagline, and the full plural sweep), then
a leg that negotiates the locale from a handful of `Accept-Language` headers
(including one where a higher `q`-weight beats header order), then the missing-key
seam — an unknown locale falling back to English, and a genuinely untranslated key
rendering as its own name while the `onMissing` log records it.

## How it's tested (the QA gate)

```bash
bun run --filter '@lesto/example-i18n' test
```

Two suites, both driving the real routes:

- **`test/i18n.test.ts`** drives the routes with `app.handle` and asserts what only
  an end-to-end wiring can prove, each assertion built to go RED if its feature
  broke:
  - the same key renders a **different** string in French than in English;
  - a `?name` is interpolated, and an absent one leaves `{name}` verbatim;
  - a `<script>` name is HTML-escaped (positive escaped-form + negative raw-tag);
  - the plural line follows each language's CLDR rules via **exact** strings — so
    French's `0 article` (0-is-singular) and Russian's `2 товара` (`few`) would
    each fail a naive `count === 1` rule;
  - the French page's tagline **falls back** to English, and that fallback is
    **not** counted as a miss (the `misses` log stays empty);
  - a key resolving nowhere renders as its own name and the `onMissing` seam logs
    it against the **requested** locale;
  - `Accept-Language` negotiation honours `q`-weights over header order and
    defaults to English for an unsupported/absent header.
- **`test/serve.smoke.test.ts`** spawns `serve.ts` under Bun on an ephemeral port
  (`PORT=0`), reads the `listening on …` line, `fetch()`es `GET /fr?name=Ada` over
  a real socket, asserts the French page rendered (`Bonjour, Ada !`, `lang="fr"`),
  then SIGTERMs and asserts a clean exit — the behavioral proof that the hosted
  entry actually boots and serves.

## How to deploy / run the hosted leg

```bash
bun run examples/i18n/serve.ts
```

`buildApp` returns a bare `@lesto/web` app, not a bootable one — `serve.ts` wraps
it with `@lesto/kernel`'s `createApp` and serves THAT behind a real `node:http`
server (`@lesto/runtime`'s `serveWithGracefulShutdown`). There is no data to
persist, so it opens a throwaway in-memory SQLite handle purely to satisfy the
kernel's `db` contract (`durable: false`, `secure: false`). Then a **browser's own
`Accept-Language`** drives `GET /`:

```bash
open http://localhost:3000/               # negotiated from your browser's languages
open http://localhost:3000/fr?name=Ada    # the French page
curl -H 'Accept-Language: fr-CA,fr;q=0.9' localhost:3000/
curl localhost:3000/ru?name=Ada
```

**Not run in this sandbox** — starting a server is blocked here. Booting is proven
instead by `test/serve.smoke.test.ts`, which spawns `serve.ts`, fetches a
localized page over a real socket, and confirms a clean SIGTERM exit. Deploying it
to Cloudflare follows the same wiring every hosted `serve.ts` in the gallery uses.

## DX findings

`@lesto/i18n` was a pleasure to wire, and the ergonomics held up under a real
request path:

- **Locale-correct plurals for free.** `plural` defers category selection to the
  platform's `Intl.PluralRules`, so French's 0-is-singular and Russian's
  one/few/many worked with zero rule-writing on our side — the catalog need only
  spell the categories a language actually uses. This is the feature most i18n
  libraries get subtly wrong, and it's the default here.
- **Missing data is loud, not silent.** A missing param stays as `{name}` and a
  missing key surfaces as its own name — both make a gap visible on screen rather
  than shipping a blank, and the `onMissing` hook turns "find the untranslated
  strings" into a metric instead of a bug report.
- **The one sharp edge is escaping, and it's documented, not hidden.**
  `interpolate` is deliberately plain-text and hands escaping to the caller. That
  is the correct call (the right encoding depends on the sink), but it means an app
  rendering into HTML **must** escape every translated string itself — easy to
  forget. A thin `@lesto/i18n`-aware render helper (or a documented pairing with
  `@lesto/ui`, which escapes by construction) would remove the last footgun; for a
  raw-string demo like this one, escaping at the render layer is the honest shape.
- **No friction at the boundary.** Reading the locale from a path param, a header,
  and a query param via `@lesto/web`'s context (`c.param` / `c.header` / `c.query`)
  needed no glue — the negotiation logic is a dozen lines of plain header parsing.
