---
title: From Next.js
description: Move a Next.js app to Lesto — route handlers to lesto() routes, app/page.tsx to file-based pages, and the in-house backend Next leaves you to assemble.
section: Migrate
order: 1
---

# From Next.js

Next.js gives you React, SSR, file routing, and great DX — then hands you a blank
page for the backend. Most Next apps end up wired to a hosted Postgres, a separate
ORM, a queue, an email vendor, and an auth provider. Lesto keeps React and the
file-routing ergonomics and ships that backend in the box, on one database.

> **Honest scope.** Lesto's frontend is React SSR + hydrated islands, not a
> drop-in clone of the Next App Router and React Server Components. If your app
> leans hard on RSC streaming, parallel routes, or the Next middleware runtime,
> port deliberately and check the [Routing guide](/guides/routing) for what maps
> cleanly. What ports very cleanly: your API routes and your page tree.

## API routes → `lesto()` routes

A Next.js route handler:

```ts
// app/api/posts/route.ts
import { NextResponse } from "next/server";

export async function GET() {
  const posts = await db.post.findMany();
  return NextResponse.json({ posts });
}

export async function POST(req: Request) {
  const { title, body } = await req.json(); // untyped
  const post = await db.post.create({ data: { title, body } });
  return NextResponse.json({ post }, { status: 201 });
}
```

The Lesto equivalent, on one app surface:

```ts
import { z } from "zod";

const NewPost = z.object({ title: z.string().min(1), body: z.string().min(1) });

app
  .get("/api/posts", async (c) => {
    const rows = await db.select().from(posts).orderBy(posts.id, "asc").all();
    return c.json({ posts: rows });
  })
  .post("/api/posts", async (c) => {
    const input = c.valid(NewPost); // validated at the boundary, or a 422
    const post = await db.insert(posts).values(input).returning().get();
    return c.json({ post }, 201);
  });
```

### Concept map

| Next.js | Lesto |
|---|---|
| `export async function GET()` | `.get("/api/posts", (c) => …)` |
| `export async function POST(req)` | `.post("/api/posts", (c) => …)` |
| `await req.json()` (+ a validator) | `c.valid(Schema)` — typed and validated |
| `app/api/posts/[id]/route.ts` | `.get("/api/posts/:id", (c) => c.param("id"))` |
| `new URL(req.url).searchParams.get("q")` | `c.query("q")` |
| `NextResponse.json(x, { status })` | `return c.json(x, status)` |
| `middleware.ts` | `.use((c, next) => …)` middleware, or `.use(can(...))` / `.use(gate(...))` |

## Pages → file-based routing

Next's `app/` directory has a near-direct analogue. A Next page:

```tsx
// app/page.tsx
export default function Home() {
  return <main><h1>Welcome</h1></main>;
}
```

becomes a Lesto file-routed page under `app/routes/`:

```tsx
// app/routes/page.tsx
import type { PageDef, PageProps } from "@lesto/web";

const load = () => ({ greeting: "Welcome" });

const page: PageDef<"/", PageProps<typeof load>> = {
  load, // runs on the server; props are inferred from its return
  component: ({ greeting }) => <main><h1>{greeting}</h1></main>,
};

export default page;
```

The conventions line up: `app/routes/[id]/page.tsx` is a dynamic segment,
`app/routes/[...rest]/page.tsx` a catch-all, and a `layout.tsx` wraps every page
at or below it — the same mental model as Next, registered by dropping a file.
Interactive components are **islands** (`defineIsland` under `app/islands/`)
rather than `"use client"` boundaries. See the [Routing guide](/guides/routing).

## What Lesto adds that Next leaves to you

This is the reason to move. Next stops at the framework boundary; Lesto's
batteries are first-party and run on the same database:

- **Typed schema + migrations** — `@lesto/db` (a query builder, not an ORM) + `@lesto/migrate`, no Prisma/Drizzle to wire.
- **Durable jobs** — `@lesto/queue` on the DB, no Redis or hosted queue.
- **Auth + RBAC** — `@lesto/auth` + `@lesto/authz`, not a third-party provider.
- **Transactional email + mailing lists** — `@lesto/mail`, queued, react-email.
- **An admin surface** — `@lesto/admin`, CRUD with pagination and audit hooks.
- **Observability** — one trace spans browser → API → DB, no OpenTelemetry dep.

## Deploy

Both target the edge: where Next deploys to Vercel, a Lesto app deploys to
Cloudflare Workers (D1 or Hyperdrive behind one database seam) — `lesto deploy
--cloudflare`. See [Deploy → Cloudflare](/deploy/cloudflare).

## Next step

[Quickstart](/quickstart) scaffolds the page + API + database structure above.
Not ready to switch frameworks? [Adopt one battery](/migrate/adopt-a-battery)
pulls a single Lesto battery into your existing Next app.
