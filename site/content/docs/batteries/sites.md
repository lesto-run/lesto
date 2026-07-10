---
title: "Sites"
description: "Declare many sites over one Lesto app — each mounted at a path, rendered static (prerendered from the app's own request handler) or dynamic (served live). A static site is just the dynamic app, rendered offline."
section: Batteries
order: 17
---

# Sites

`@lesto/sites` lets one project expose several **sites** over the same app and
substrate. A site is a named view mounted at a path, rendered either *static*
(prerendered to files and served from a CDN) or *dynamic* (served live, per
request). The package leans on one idea: a static site is just the dynamic app,
rendered offline. Prerendering calls the app's own request handler for each
route and captures exactly what a live request would return — so there is no
second rendering path to keep in sync.

## Declare the sites

`defineSites` takes a set of site declarations and validates them up front. Each
site has a `name` (unique, and also its output directory) and a `basePath` (the
mount point — `/` for the root, `/mls` for a zone). A `static` site adds the
`pages` it should prerender; a `dynamic` site has no extra fields.

```ts
import { defineSites } from "@lesto/sites";

const sites = defineSites([
  { name: "marketing", render: "static", basePath: "/", pages: ["/", "/about"] },
  { name: "mls", render: "dynamic", basePath: "/mls" },
]);
```

Validation happens at config time, not serve time: a site needs a non-empty
name, a name must be a plain slug (lowercase letters, digits, `-`, `_` — it
becomes a path segment, so nothing that could escape the output tree), names
must be unique, every `basePath` must start with `/`, and no two sites may mount
at the same `basePath`. A duplicate mount would make request selection
ambiguous, so it throws a `SitesError` (`SITES_DUPLICATE_BASE_PATH`) instead of
producing a confusing `404` later. `defineSites` returns the sites unchanged and
fully typed for the runtime and the build to consume.

## Static pages, fixed or derived

A `StaticSite`'s `pages` is a `PagesSource`: either a fixed list of routes
(relative to `basePath`), or a function returning one. The function form lets the
page list come from a content collection, a database query, or anywhere else,
resolved at build time — and it may be async.

```ts
import { defineSites } from "@lesto/sites";
import { listPostSlugs } from "./posts";

const sites = defineSites([
  {
    name: "blog",
    render: "static",
    basePath: "/blog",
    pages: async () => ["/", ...(await listPostSlugs()).map((s) => `/${s}`)],
  },
]);
```

Each route is joined to the site's `basePath` to form the path the app actually
renders — `sitePath("/blog", "/hello")` is `/blog/hello` — and mapped to an
output file by `outputPath`. A page becomes a clean-URL directory plus
`index.html` (`outputPath("blog", "/about")` → `blog/about/index.html`); a route
whose last segment has an extension is written verbatim
(`outputPath("blog", "/sitemap.xml")` → `blog/sitemap.xml`), the same split most
static generators make between pages and endpoints.

## Prerender from the app's handler

`prerenderSite(site, handle)` renders one static site. It resolves the site's
pages, then for each route calls `handle("GET", path)` — the exact code path a
live request takes — and captures the response. `handle` is typed as a
`PageHandler`, a structural shape that `@lesto/web`'s own `app.handle` satisfies
with no adapter.

```ts
import { prerenderSite, writePages, nodeSink } from "@lesto/sites";
import { app } from "./app";

const pages = await prerenderSite(sites[0], app.handle);
await writePages(pages, nodeSink("out"));
```

The handler's body may be a `string`, raw `Uint8Array` bytes, a
`ReadableStream<Uint8Array>` (the framework streams React SSR this way), or
`undefined`. `prerenderSite` drains whichever arm it gets to raw bytes, so a
`.page` route's streamed SSR and a binary route (a generated PNG, a font) both
land byte-identical. Each `RenderedPage` carries its origin `path`, its
`outputPath`, the response `status`, the raw `body` bytes, and an `html` UTF-8
view of those bytes for the common text case.

## Write through a sink

`writePages(pages, sink)` hands each rendered page to an `OutputSink` — the only
thing that touches the outside world. `nodeSink(rootDir)` is the default,
writing under a local directory; any sink with the same shape (an S3 upload, an
in-memory map for tests) works unchanged. The sink seam carries **bytes**, so a
prerendered binary route is never decoded-then-corrupted on its way out; a
`string` overload UTF-8-encodes text for the HTML case.

```ts
import { writePages, nodeSink } from "@lesto/sites";

await writePages(pages, nodeSink("dist"));
```

`nodeSink` resolves each path against the root and refuses to write outside it,
throwing `SitesError` (`SITES_PATH_ESCAPE`) — a guard for slugs that come from
untrusted content and might contain `..`.

## Build every static site at once

`buildStaticSites(sites, handle, sink)` is the whole pipeline: it filters the set
to its static sites, prerenders them all, and writes them — but only if every
page rendered cleanly. Dynamic sites are skipped, since they are served live.

```ts
import { buildStaticSites, nodeSink } from "@lesto/sites";
import { app } from "./app";

const manifests = await buildStaticSites(sites, app.handle, nodeSink("dist"));
```

The build is all-or-nothing. It prerenders every static site first and collects
any page the app answered with a non-2xx status; if **any** page failed, it
throws `SitesError` (`SITES_PAGE_FAILED`) — naming each failing path and status —
before a single file is written. On success it writes every page and returns one
`SiteManifest` per site, listing each page's `path`, `outputPath`, and `status`.

## Sitemap, robots, and the OG card

A fully prerendered site also ships its discoverability files, and
`defineStaticSite` owns that emit so your build script doesn't. Give it the
site's origin and route list; it derives the sitemap (priority `1` for `/`,
`0.7` elsewhere — override with `priority`) and returns an `emit(sink)` that
writes `sitemap.xml`, `robots.txt`, and — when given — an `og.svg` and
`favicon.svg` through the same `OutputSink` the pages use:

```ts
import { defineStaticSite, nodeSink } from "@lesto/sites";
import { ogImage } from "@lesto/seo";

const site = defineStaticSite({
  siteUrl: "https://example.com",
  routes: ["/", "/about", "/pricing"],
  og: ogImage({ title: "Example", footer: "example.com" }),
});

await site.emit(nodeSink("out"));
```

The strings come from [`@lesto/seo`](/batteries/seo)'s pure builders, so
everything on this path stays substrate-agnostic — a sink, not a filesystem.

## Notes and gotchas

- **Static is the dynamic app, rendered offline.** There is no separate static
  renderer. `prerenderSite` calls your real `app.handle`, so whatever a page
  renders live is what gets written. Build static pages the same way you write
  any [route](/guides/routing) — the prerenderer just calls them for you.
- **A broken page fails the whole build.** `buildStaticSites` writes nothing if
  any page returns a non-2xx status. This is deliberate: it never ships a
  half-broken static build. Make sure routes that should prerender actually
  answer `2xx` for a plain `GET`.
- **Validation is at config time.** Empty or duplicate names, an unrooted
  `basePath`, or two sites at the same mount each throw from `defineSites`
  immediately — a typo is a clear error before serving, not an ambiguous `404`.
- **The sink carries bytes, not strings.** A static site can include binary
  routes (a generated image, a font). The sink and `RenderedPage.body` are
  `Uint8Array` precisely so those land byte-identical; `RenderedPage.html` is a
  lossy UTF-8 view for text and should not be written for binary routes.
- **`nodeSink` refuses path traversal.** A page path that resolves outside the
  output root is rejected (`SITES_PATH_ESCAPE`). When pages come from a function
  driven by content slugs, this keeps a malicious `..` from escaping the build
  directory.
- **Pages are GET-only.** `prerenderSite` always calls `handle("GET", path)`.
  Static sites model pages, not form posts; dynamic behaviour stays on a
  `dynamic` site served live.

For how `app.handle` and routes work, see [Routing & pages](/guides/routing); to
gate a whole zone behind a flag, see [Feature flags](/batteries/flags).
