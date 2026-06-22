# Analytics — a forward-port seam

Product analytics for the docs site, set up **intentionally** so that adopting
the in-house `@lesto/analytics` battery later is **lift-and-fit, not a rewrite**.

## The shape

```
client.ts          ← the seam: the Analytics interface + AnalyticsDriver (vendor-free)
posthog-driver.ts  ← the ONLY file that knows PostHog exists (the interim driver)
config.ts          ← PostHog public key + host (empty key = analytics OFF)
init.ts            ← boots analytics + wires [data-analytics] click tracking
../islands/analytics.tsx  ← headless island that runs init.ts on every page
```

Everything the rest of the site touches goes through `client.ts`:

```ts
analytics.page();
analytics.track("clicked_open_in_codespaces");
analytics.identify(userId);
```

…or, declaratively, via a `data-analytics="event_name"` attribute on any element
(see the header nav links in `src/ui/layout.tsx`).

## Why it's built this way (the lift-and-fit plan)

This mirrors Lesto's own principle — *own the API, keep a driver seam underneath*
(ARCHITECTURE §1.2). The `Analytics` interface here is intentionally the shape the
browser client of `@lesto/analytics` will expose. So when the battery ships:

| Stays unchanged | Changes |
|---|---|
| Every `analytics.page/track/identify` call site | — |
| Every `data-analytics="…"` attribute | — |
| The `Analytics` interface (`client.ts`) | — |
| `init.ts` flow | one line: `posthogDriver()` → the battery's browser client |
| — | `posthog-driver.ts`, `config.ts` deleted |
| — | `../islands/analytics.tsx` deleted (the framework injects the client into the client entry, like `@lesto/observability`'s RUM client — ARCHITECTURE §7) |

So PostHog is a removable, interim **backend**, never baked into the site.

## Turning it on

Analytics is **OFF by default** — `config.ts` ships an empty `key`, so no SDK
loads and no cookie is set. To enable it, put your PostHog **public** project key
(`phc_…`, safe in client JS) in `config.ts`. Mind the usual client-analytics
consent considerations before flipping it on for real traffic; `respect_dnt` is
already set in the driver.
