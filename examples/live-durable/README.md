# Durable `live()` — OPFS-SQLite store (ADR 0042 Tier 4, v1 Inc5/Inc6)

The durable client store's intended end-to-end round trip — and, as it turned out, the
reproduction of a bundler defect that currently blocks it in a production build (tracked as
`L-4ed8e591`; see [The bundler finding](#the-bundler-finding-the-crux-of-this-example)):

```ts
const { db } = await openOpfsSqliteDatabase();
const store = await createSqliteLiveStore({ def: notesShape, db, onError });
const query = createLiveQuery(notesShape, { store });
```

`openOpfsSqliteDatabase` (`@lesto/live`) boots `@sqlite.org/sqlite-wasm` over the Origin
Private File System; `createSqliteLiveStore` wraps that connection in a `LiveStore` that
mirrors every mutation in memory AND persists the row batch + resume cursor atomically;
`createLiveQuery` opens the `GET /__lesto/live-data` subscription against it. The intended
demo: add a note, reload the page (even offline), and it repaints **instantly** from the
OPFS-persisted slice — before the live stream reconnects. That instant repaint is the whole
point of the durable tier; a plain in-memory store would paint nothing until the first
snapshot arrived.

> **⚠️ As bundled by the documented `bun run build` below, this demo does NOT work yet.** The
> production build silently drops the SQLite engine (the finding below), so
> `openOpfsSqliteDatabase` throws and the durable store never opens. Reproducing that defect is
> what this example proves today; the instant-repaint demo lands once `L-4ed8e591` fixes the
> bundler wiring (or via the app-side import-map workaround described below).

`src/schema.ts` defines the one `notes` table and its bound shape and is imported by BOTH
`src/main.ts` (the client) and `src/app.ts` (the server) — one schema, two runtimes, the ADR
0042 pitch made concrete.

## How to run it (the manual step this repo's sandbox cannot do for you)

```bash
bun install                        # from the repo root, links the workspace packages
cd examples/live-durable
bun run build                      # vite build -> dist/
bun run serve                      # boots the API + serves dist/ on :3000
```

Then open **http://127.0.0.1:3000 in a real browser** (OPFS needs one — there is no Node/Bun
OPFS implementation, which is also why this file has no vitest suite; `packages/live`'s
`opfs-sqlite.ts` is coverage-excluded for the same reason). **With the committed build the
durable store fails to open** (the bundler finding below), so the reload-persists round trip is
what this example is DESIGNED to show and will show once `L-4ed8e591` lands — not what the
committed `dist/` does today. What the build DID prove is the bundler defect itself; that
browser round-trip is also the one piece this sandbox cannot execute.

## The bundler finding (the crux of this example)

`openOpfsSqliteDatabase` reaches the optional `@sqlite.org/sqlite-wasm` peer through
`import(SQLITE_WASM_MODULE)`, where `SQLITE_WASM_MODULE` is a `const` **typed as a bare
`string`** (not a literal), specifically so `tsc` never tries to resolve the peer for an app
that has not installed it. This example exists to answer the question the original Inc5
docstring hedged: does a real bundler survive that same trick?

**No — and worse than a warning.** With `@sqlite.org/sqlite-wasm` actually installed
(`bun install` above), running the exact command a production deploy would run:

```bash
bunx vite build
```

produces:

```
dist/index.html   0.81 kB
dist/index.js    12.30 kB
✓ built in ~80ms
```

12 KB is suspicious for a bundle that is supposed to carry a WASM SQLite engine. Inspecting
`dist/index.js` confirms why: it still contains the literal source text
`import(<minified-name-of-SQLITE_WASM_MODULE>)` — an **unresolved bare specifier**. None of
`@sqlite.org/sqlite-wasm`'s code, its `sqlite3.wasm` binary, or its worker/proxy scripts were
copied into `dist/` at all. A browser loading this bundle would hit
`import("@sqlite.org/sqlite-wasm")` at runtime and throw (`Failed to resolve module
specifier` — bare specifiers are not valid in native ESM without an import map), so
`openOpfsSqliteDatabase` would report the durable store as unavailable **even though the
peer is installed**.

A side-by-side isolated test (a throwaway Vite config, not part of this example) confirms
the cause precisely: the identical `import(...)` call bundles the peer's full ~1.1 MB
(JS + `.wasm` + worker) when the specifier is a **literal** string, and bundles **nothing**
when it goes through a `const` variable — with `vite build` printing zero warning either
way, even with an explicit Rollup `onwarn` hook logging every warning it fires. Rollup's
static import-graph analysis simply cannot see through a non-literal specifier, and treats a
`import()` it cannot analyze as an opaque runtime expression rather than a build error or a
lint warning.

**Neither of the two things you would normally reach for changes this.** We tried both,
rebuilt, and diffed the output byte-for-byte:

- `import(/* @vite-ignore */ SQLITE_WASM_MODULE)` (now present in `opfs-sqlite.ts`) only
  suppresses Vite's *dev-server* console warning ("this dynamic import cannot be analyzed by
  Vite") for someone running `vite dev` — the production `vite build` output was identical
  with or without it.
- `optimizeDeps.exclude: ["@sqlite.org/sqlite-wasm"]` (present in `vite.config.ts`) only
  steers the dev server's `esbuild` dependency **scan**, which does not run during
  `vite build` at all.

Both are kept anyway as the honest, standard signal of intent — but this README and
`packages/live/src/opfs-sqlite.ts`'s module doc say plainly that they do not fix production
bundling, rather than imply they do.

**What would actually fix it** (tracked as `L-4ed8e591`, not solved here). The leading
candidate is library-side: expose the durable engine as a dedicated opt-in **subpath export**
(e.g. `@lesto/live/opfs`) that reaches the peer through a **literal**
`import("@sqlite.org/sqlite-wasm")`. A literal bundles the peer in full (the side-by-side above
proves that); keeping it OUT of the main `@lesto/live` barrel means a peer-less consumer
importing `@lesto/live` never pulls the literal into its `tsc`/bundler graph, while an opt-in
app that imports the subpath has already installed the peer and resolves it cleanly. Only a raw
literal in a barrel-exported file reopens the `tsc` requirement — a separate subpath does not.
Alternatively an app can resolve it app-side: its own literal `import("@sqlite.org/sqlite-wasm")`
plus a matching import map.

## Peer-version note

`@lesto/live`'s declared peer range is `@sqlite.org/sqlite-wasm@^3.46.0`. As of this writing
every version of that package published past `3.41.2` carries a `-buildN` prerelease suffix
(e.g. `3.46.1-build5`), which semver excludes from a bare caret range — `^3.46.0` cannot
actually resolve to anything on the registry. This example pins the exact version
`3.46.1-build5` to install at all; the peer range itself is out of this example's scope to
fix (`packages/live/package.json`).
