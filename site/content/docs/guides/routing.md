---
title: Routing & pages
description: Code-first routes, file-based routing, page loaders and metadata, and client-side soft navigation.
section: Guides
order: 0
---

# Routing & pages

Lesto routes two ways — code-first or file-based — over one router.

## Code-first

Declare routes on the `lesto()` builder. A page has a `component`, an optional
server `load`, and optional `metadata`:

```ts
app
  .page("/posts", {
    load: async () => ({ posts: await listPosts(db) }),
    component: PostsPage,
    metadata: () => ({ title: "Posts" }),
  })
  .get("/api/posts", async (c) => c.json({ posts: await listPosts(db) }));
```

Mark a page `static: true` to prerender it to a cacheable file.

## File-based

Drop files under `app/routes/` and they become routes (ADR 0023): `page.tsx`
makes a directory a route, `layout.tsx` wraps everything at or below it, and a
`[id]` segment is a typed param.

```
app/routes/
  page.tsx              → /
  posts/
    page.tsx            → /posts
    [id]/page.tsx       → /posts/:id
```

Each `page.tsx` default-exports a `PageDef` (the same shape as a code-first page);
`applyFileRoutes` compiles the tree onto the app. File routes and code-first
routes coexist on one router.

## Soft navigation

`<Link>` is an ordinary `<a href>` that works with JavaScript off. With the client
runtime loaded, `enableSoftNav` upgrades in-app clicks to fetch-and-swap the next
page without a full reload, re-hydrating islands and restoring scroll (ADR 0024):

```tsx
import { Link } from "@lesto/ui";
import { enableSoftNav } from "@lesto/ui/client";

<Link href="/posts/42">View post</Link>
<Link href="/report.pdf" reload>Download</Link>   // opt out: full navigation
```
