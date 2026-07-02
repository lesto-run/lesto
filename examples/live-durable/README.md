# Durable `live()` — OPFS-SQLite store (ADR 0042 Tier 4, v1 Inc5/Inc6)

The durable client store's end-to-end round trip, bundled through a real Vite production
build — and the record of a bundler defect this example exposed and then fixed along the way
(`L-f5bffa40` → `L-4ed8e591`):

```ts
const { db } = await openOpfsSqliteDatabase();          // from @lesto/live/opfs (the opt-in subpath)
const store = await createSqliteLiveStore({ def: notesShape, db, onError });
const query = createLiveQuery(notesShape, { store });
```

`openOpfsSqliteDatabase` (`@lesto/live/opfs`) boots `@sqlite.org/sqlite-wasm` over the Origin
Private File System; `createSqliteLiveStore` wraps that connection in a `LiveStore` that
mirrors every mutation in memory AND persists the row batch + resume cursor atomically;
`createLiveQuery` opens the `GET /__lesto/live-data` subscription against it. The payoff: add a
note, reload the page (even offline), and it repaints **instantly** from the OPFS-persisted
slice — before the live stream reconnects. That instant repaint is the whole point of the
durable tier; a plain in-memory store would paint nothing until the first snapshot arrived.

`src/schema.ts` defines the one `notes` table and its bound shape and is imported by BOTH
`src/main.ts` (the client) and `src/app.ts` (the server) — one schema, two runtimes, the ADR
0042 pitch made concrete.

## How to run it (the manual step this repo's sandbox cannot do for you)

```bash
bun install                        # from the repo root, links the workspace packages
cd examples/live-durable
bun run build                      # vite build -> dist/ (now bundles the ~1.1 MB engine)
bun run serve                      # boots the API + serves dist/ on :3000
```

Then open **http://127.0.0.1:3000 in a real browser** (OPFS needs one — there is no Node/Bun
OPFS implementation, which is also why this file has no vitest suite; `packages/live`'s
`opfs-sqlite.ts` is coverage-excluded for the same reason). Add a note, then reload: the note is
still there instantly, painted from the durable slice. That browser session is the one piece
this repo's sandbox cannot execute; the `vite build` — which now emits `sqlite3.wasm` and the
worker chunks (see below) — is what it verifies here.

## The bundler finding (why this example exists)

`openOpfsSqliteDatabase` reaches the OPTIONAL `@sqlite.org/sqlite-wasm` peer through a dynamic
`import(...)`. The original Inc5 shape used a `const` **typed as a bare `string`** as the
specifier, specifically so `tsc` never tries to resolve the peer for an app that has not
installed it. This example exists to answer the question that shape hedged: does a real bundler
survive the same trick?

**No — and worse than a warning.** A non-literal specifier defeats a production bundler exactly
the way it defeats `tsc`: Rollup/Vite's static import-graph analysis cannot see through the
variable, treats the `import()` as an opaque runtime expression, and **silently drops it — no
diagnostic at all** (confirmed with an explicit Rollup `onwarn` hook: zero warnings). The build
came out ~12 KB with NONE of the engine — no JS, no `sqlite3.wasm`, no worker/proxy scripts —
leaving an unresolved bare specifier that throws in the browser, so `openOpfsSqliteDatabase`
would report the durable store unavailable **even though the peer is installed**. A side-by-side
build confirmed the cause precisely: the identical `import(...)` bundles the peer's full ~1.1 MB
when the specifier is a **literal**, and bundles **nothing** through a `const` variable. Neither
`@vite-ignore` (a dev-server console-warning suppressor) nor `optimizeDeps.exclude` (a
dev-server esbuild-scan steer, never run during `vite build`) changes the production output.

**The fix (now in `opfs-sqlite.ts`, `L-4ed8e591`):** use a **literal**
`import("@sqlite.org/sqlite-wasm")`, and move the engine to a dedicated opt-in **subpath export**
`@lesto/live/opfs` that is NOT re-exported from the main `@lesto/live` barrel. The subpath is
what resolves the literal-vs-`tsc` tension: a consumer importing `@lesto/live` never pulls the
engine (or its literal) into its `tsc`/bundler graph, while an app that imports `@lesto/live/opfs`
has already installed the peer — so the literal resolves for its `tsc` AND bundles for its build.
(Only a raw literal in a barrel-exported file would reopen the `tsc` requirement; a separate
subpath does not.) With that in place, `bun run build` here now emits:

```
dist/sqlite3.wasm                                  939.20 kB
dist/assets/sqlite3-worker1-bundler-friendly-*.js  206.23 kB
dist/assets/sqlite3-opfs-async-proxy-*.js            9.45 kB
dist/assets/index-*.js                             209.06 kB   # engine JS, folded in
dist/index.js                                       13.40 kB
```

— the ~1.1 MB engine is in `dist/`, and the durable store opens.

## Peer-version note (`L-cfaa4d07`)

`@sqlite.org/sqlite-wasm` publishes every version past `3.41.2` with a `-buildN` prerelease
suffix (e.g. `3.46.1-build5`), which semver excludes from a bare caret range — the original
`^3.46.0` peer range could not resolve to ANY published version. Because each version is a
prerelease on its own tuple, no broad range matches without `includePrerelease` (which package
managers don't apply to dependency ranges), so `@lesto/live` now pins the peer range to
`^3.46.1-build5` (the proven-good build line) and this example depends on the exact
`3.46.1-build5`.
