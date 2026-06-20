---
title: Routing & pages
description: Code-first routes, file-based routing, page loaders and metadata, and client-side soft navigation.
section: Guides
order: 0
---

# Routing & pages

Lesto routes two ways — code-first or file-based — over **one** router. An API
route and a page are the same kind of route: a chain of handlers whose terminal
either answers the request or renders a React component. Pick whichever authoring
style fits a feature; both compile onto the same `lesto()` app, so they coexist
with no second router. See [Concepts](/concepts) for how routes, middleware, and
layouts compose.

## Code-first

Declare routes on the `lesto()` builder. The builder is chainable: `.get` /
`.post` / `.patch` / `.delete` register API handlers, and `.page` registers a
page with a `component`, an optional server `load`, and optional `metadata`.

```ts
import { lesto } from "@lesto/web";

const app = lesto()
  .page("/posts", {
    load: async () => ({ posts: await listPosts(db) }),
    component: PostsPage,
    metadata: () => ({ title: "Posts", description: "Everything we've written." }),
  })
  .page("/posts/:id", {
    load: (c) => ({ post: findPost(c.param("id")) }),
    component: PostPage,
  })
  .get("/api/posts", (c) => c.json({ posts: listPosts(db) }))
  .post("/api/posts", (c) => c.json(createPost(c.valid(NewPost)), 201));
```

`c.param("id")` is typed to the pattern's `:id`, with no codegen. A page's
component props are inferred straight off its `load` — whatever `load` returns is
what `component` receives.

### Validated params and body

A page may declare a `params` schema (a Zod type) that validates the **query
string** at the boundary. A malformed query is a `400` before `load` ever runs;
on success the parsed value is stashed for the handler to read.

```ts
import { z } from "zod";

app.page("/search", {
  params: z.object({ q: z.string().min(1), page: z.coerce.number().default(1) }),
  load: (c) => {
    const { q, page } = c.get("params") as { q: string; page: number };
    return { results: search(q, page) };
  },
  component: SearchPage,
});
```

API handlers validate the **request body** the same way with `c.valid(schema)` —
a failure throws the coded error the boundary maps to a `4xx`. See
[Validation](/guides/validation) for the full boundary story.

### Static pages and cache posture

Mark a page `static: true` to prerender it once into a cacheable file rather than
render it per request. A static page resolves **no** per-request data at render —
its islands fetch their own per-user data on the client — so a build-time value
(say, "signed out", because there's no request cookie at prerender) is never
baked into the shared HTML. A dynamic page (the default) inlines its data with no
client waterfall.

```ts
app.page("/about", { component: AboutPage, static: true });
```

Cache headers follow from that. A dynamic page that *could* inline private data
is stamped `Cache-Control: private, no-store`; a page that binds no private
source can opt back into the cacheable default with `cache: "public"`. A static
page is already cacheable, so `cache` is moot there.

## File-based

Drop files under `app/routes/` and they become routes. `page.tsx` makes a
directory a route, `layout.tsx` wraps every route at or below it, and a `[id]`
segment is a typed param that compiles to the router's `:id`:

```
app/routes/
  layout.tsx            → wraps every route below
  page.tsx              → /
  posts/
    page.tsx            → /posts
    [id]/page.tsx       → /posts/:id   (typed param `id`)
```

Each `page.tsx` default-exports a `PageDef` — the **same shape** as a code-first
page (`component`, `load`, `metadata`, `params`, `static`, `cache`). The `[id]`
directory compiles to `:id`, so `load` reads it with the same typed
`c.param("id")` a hand-written route would:

```tsx
import type { PageDef } from "@lesto/web";

const page: PageDef<"/posts/:id", { post: Post }> = {
  load: (c) => ({ post: findPost(c.param("id")) }),
  component: ({ post }) => <article>{post.title}</article>,
  metadata: ({ post }) => ({ title: post.title }),
};

export default page;
```

`applyFileRoutes` does the wiring. It compiles the discovered files into ordered
descriptors — deriving each URL pattern, nesting layouts outermost-first, ordering
pages most-specific-first (a literal `posts/new` shadows `posts/[id]`), and
refusing two pages that answer the same URLs — then registers each page on the
app, wrapped in its own layout chain. Because those become ordinary `.page()`
registrations on the **same** `Lesto` instance your code-first routes live on,
file routes and code routes share one router. The estate example wires both side
by side: see
[examples/estate](https://github.com/lesto-run/lesto/tree/main/examples/estate).

## Page loaders & metadata

`load` runs **on the server**. It receives the request context (`c.param`,
`c.query`, headers, the validated `params`) and returns the props the component
renders with — the data fetch happens before the component, so there's no
client-side loading waterfall. Authorization and feature gating sit in front as
middleware (`.use(...)`), guarding a page and its whole subtree exactly as they
guard API routes.

`metadata` turns the loaded props into the document `<head>`. It returns a
`title`, a `description`, and optional `meta` / `links` arrays; the framework
always emits `charset` and `viewport` first, then your tags, de-duplicated:

```ts
metadata: ({ post }) => ({
  title: `${post.title} · Blog`,
  description: post.excerpt,
  links: [{ rel: "canonical", href: `/posts/${post.slug}` }],
}),
```

## Soft navigation

A `<Link>` is an ordinary `<a href>`. It renders the same markup on the server
and in an island, it's crawlable, and it works with **JavaScript off** — a normal
full-document navigation. That's the floor soft nav never drops below.

With the client runtime loaded, `enableSoftNav(registry)` installs one delegated
click listener that upgrades eligible in-app clicks: it fetches the next page,
swaps its `<body>` in place, re-hydrates the islands against the swapped document,
updates history, and restores scroll — no full reload, no white flash. Back and
Forward replay the same swap from `popstate`, restoring each entry's saved scroll
position.

```tsx
import { Link } from "@lesto/ui";
import { enableSoftNav, hydrateDocumentIslands } from "@lesto/ui/client";

hydrateDocumentIslands(registry);
enableSoftNav(registry);
```

```tsx
<Link href="/posts/42">View post</Link>
<Link href="/report.pdf" reload>Download</Link>   // opt out → full navigation
```

Soft nav is a pure enhancement, never load-bearing for correctness. It declines
automatically when a link is cross-origin, a download, targets another frame, or
the click carries a modifier key (the user asked for a new tab) — every case
where a swap would be wrong. The `reload` prop forces a full navigation for a link
that must re-run the document, such as a logout that clears client state. And if a
fetch or swap throws, the default recovery is a real navigation to the
destination, so a soft-nav failure degrades to exactly the navigation the link
would have done with no JavaScript at all.
