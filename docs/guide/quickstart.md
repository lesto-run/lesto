# Quickstart — your first Lesto app

This walks the first five minutes: scaffold an app, run it, see a server-rendered
page with a live (hydrated) island, and add a route. It mirrors the CI-gated
scaffold loop (`packages/e2e/scaffold-loop.spec.ts`), so the commands here are the
ones that are actually exercised on every change.

## Prerequisites

- [Bun](https://bun.sh) (the runtime + package manager)
- Node ≥ 22 (for runtime compatibility)

## 1. Scaffold

```sh
npm create lesto-app my-app
# or, with Bun:  bun create lesto my-app
cd my-app
bun install
```

> **Pre-publish note.** Until the first `0.x` publish (see [RELEASING.md](../../RELEASING.md)),
> the public `@lesto/*` packages are not on npm yet. To try Lesto from a clone of this
> repo, scaffold with the in-monorepo flag, which pins the packages at local `file:`
> paths instead of registry ranges:
>
> ```sh
> bun packages/create-lesto/src/bin.ts my-app --local
> ```

The scaffold writes a small but real app: a `posts` table (a `@lesto/db` value), a
migration, a code-first `lesto()` app with `/`, `GET /posts`, and `POST /posts`, and
one island (`app/islands/counter.tsx`).

## 2. Run it

```sh
bun run dev          # lesto dev — every site live on one origin (default :3000)
```

Open <http://localhost:3000>. The page is server-rendered; the **count** button is
a deferred island — clicking it (and watching the number change) is the visible
proof the Preact client bundle hydrated.

```sh
# the JSON API the starter ships:
curl -H "Sec-Fetch-Site: same-origin" http://localhost:3000/posts
```

> Security is on by default (ADR 0016). The starter sets `secure: { originCheck: {} }`,
> so a state-changing request without a same-origin `Sec-Fetch-Site` header is refused —
> hence the header above when testing `POST`/JSON routes with `curl`.

## 3. The shape of the app

`lesto.app.ts` is the whole application — it default-exports the `LestoAppConfig` that
`lesto dev` boots:

- **`posts`** — a table defined as a value with `defineTable`; the same value backs
  the migration's DDL and the typed row every query returns.
- **`buildApp(db)`** — a closure factory returning a `lesto()` app. Routes read top to
  bottom: `.get`/`.post` for the API, `.page` for server-rendered pages, `.client`
  for the island bundle.
- **Validation at the boundary** — `POST /posts` runs the body through a Zod schema
  via `c.valid` before it touches the DB (a bad body is a `422`, never a crash).

## 4. Add a route

In `buildApp`, chain another handler:

```ts
// add `eq` to the existing `@lesto/db` import at the top of lesto.app.ts
.get("/posts/:id", async (c) => {
  const id = Number(c.param("id"));
  const post = await db.select().from(posts).where(eq(posts.id, id)).get();
  return post ? c.json({ post }) : c.notFound();
})
```

Restart `lesto dev` and `curl http://localhost:3000/posts/1`.

## Next

- [Batteries](./batteries.md) — what's in the box and the example that proves each.
- [Deploying to Cloudflare](./deploy-cloudflare.md) — ship it to the edge.
- [CONVENTIONS.md](../../CONVENTIONS.md) — the engineering bar, if you'll contribute.
