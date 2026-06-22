# Try Lesto — no install

👋 You're in a ready-to-go Lesto environment. Bun is installed and the whole
workspace is already `bun install`ed — nothing to set up. Pick one of the paths
below.

> **Why a Codespace and not an in-browser playground?** Lesto runs on **Bun** and
> uses the native **better-sqlite3** addon. Browser-sandbox playgrounds (StackBlitz
> and friends) run Node-in-the-browser and can't load either, so they'd give you a
> broken app. A Codespace is a real Linux container — everything just works.

## 1. Run a real app (≈10 seconds)

Boot the blog example over live HTTP:

```sh
bun run examples/blog/serve.ts
```

It runs migrations, seeds a few posts, and serves on port **3000** — the editor
auto-forwards it and opens a preview. Then hit the routes:

```sh
curl http://localhost:3000/posts        # server-rendered HTML
curl http://localhost:3000/api/posts    # JSON API
```

Other example servers work the same way — try `examples/admin/serve.ts`,
`examples/queue-dashboard/serve.ts`, or `examples/mailing-lists/serve.ts`.

## 2. Scaffold your own app

`npm create lesto` lands when the packages publish to npm. Until then, scaffold
straight from this repo with the in-monorepo (`--local`) pin:

```sh
bun packages/create-lesto/src/bin.ts my-app --local
cd my-app && bun install && bun run dev
```

You get a real app — a typed `posts` table, a migration, an SSR page with a
hydrated island, a JSON API, and security on by default. Open `lesto.app.ts` —
that's the whole app. The generated `README.md` has a copy-paste "Try it" curl.

## 3. Read the source

The batteries live under [`packages/`](../../packages); the reference
implementation is [`packages/queue`](../../packages/queue). The product story is
in [`ARCHITECTURE.md`](../../ARCHITECTURE.md), and the docs are at
[docs.lesto.run](https://docs.lesto.run) (start with
[Why Lesto](https://docs.lesto.run/why-lesto)).

---

Like what you see? ⭐ the repo, and say hi — see [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
