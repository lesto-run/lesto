# ADR 0009 — Per-island code-splitting (lazy `load` islands)

- **Status:** Accepted (capability in `@keel/ui` + estate wired; 2026-06-11)
- **Date:** 2026-06-11
- **Context:** the named follow-up from ADR 0008's companion note. Visible (lazy) hydration deferred an island's mount **work**, but Keel shipped one `client.js`, so every island's **bytes** still arrived up front. This ADR makes a lazy island's code its own chunk, fetched only when the island actually mounts.
- **Relates to:** ADR 0007 (client byte budget), ADR 0008 (whose companion note scoped this out as "a separate, larger follow-up, not claimed here").

## Context

`hydrate: "visible"` postponed running an island's code, not delivering it: the component function was referenced eagerly by the registry, so the bundler had no seam at which to split it. True byte deferral needs the component to be reachable **only** through a dynamic `import()` — then any splitting bundler emits it as a chunk, and the browser fetches it at mount time.

The interesting design question was the wire: how does the client know which chunk belongs to which island? Early sketches added a chunk map (a `chunk?: string` on `IslandMount`, or a sibling manifest). All of that turned out to be unnecessary: the dynamic `import("./chunk-x.js")` the bundler emits inside `client.js` already resolves relative to `/client.js`'s own URL, exactly like any ESM graph. **No manifest change, no chunk map, no new wire contract** — the manifest still carries only the component's *name*; the loader closure carries the code's location implicitly.

## Decision

### 1. `ClientComponentDef` becomes a discriminated union (eager | lazy)

```ts
type ClientComponentDef = EagerClientComponentDef | LazyClientComponentDef;

interface EagerClientComponentDef extends Base { component: ComponentType; load?: never; ssr?: boolean }
interface LazyClientComponentDef  extends Base { load: () => Promise<ComponentType>; component?: never; ssr?: false }
```

- **Eager (`component`)** — the component ships in the main bundle; the only form that may declare `ssr: true` (the server must hold the real component to render it into the shell).
- **Lazy (`load`)** — canonically `() => import("./x").then(m => m.X)`. Always deferred: the server's shell is its `fallback`; the client swaps it for the loaded component with a fresh mount once the chunk arrives.

A union, not two optional fields: the compiler forbids both/neither and forbids `ssr: true` on lazy. `defineClient` re-checks both at runtime for un-typed callers with coded errors (`UI_CLIENT_COMPONENT_MISSING`, `UI_CLIENT_SSR_NEEDS_COMPONENT`) — a clear define-time refusal beats an undefined-component crash at hydrate time.

### 2. `hydrateIslands` mounts lazily-arriving components with identical resilience

`mountOne` now reports `"now"` (eager — the unchanged synchronous path) or `"later"` (lazy — chunk in flight). A lazy island is recorded under the existing `deferred` result list (the same truthful "found, pending" bucket visible islands use), and its eventual outcome is appended to the caller-held `mounted`/`failed` arrays on arrival. A **rejected load is treated exactly like a throwing mount**: routed to `onMountError`, recorded in `failed`, page unharmed. Composed with `hydrate: "visible"`, the chunk fetch itself waits for first intersection — a below-the-fold island costs no code AND no work until seen.

### 3. estate wires it (the proof)

- `src/account-fallback.tsx` — the fallback moved to its own module **on purpose**: a bundler splits a module only when it is reached *exclusively* dynamically, and the registry must import the fallback statically (the server renders it eagerly). One static import of `account.tsx` would pin the whole island back into the main bundle.
- `src/registry.tsx` — `Account` is now `load: () => import("./account").then(m => m.Account)`.
- `build-client.ts` — `splitting: true`; writes the entry to `--outfile` and every chunk beside it under its generated (hashed) name, which the entry references relatively. All three serving paths already handle the chunks with zero changes: `dispatchSites`/`dispatchSitesDev` serve any `.js`, and the Cloudflare assets binding serves the whole directory.

Measured (preact deploy build): `client.js` 11,491 B + shared runtime chunk 19,542 B (statically imported), with Account + its session client isolated in a 739 B chunk that is **dynamically** imported — verified by inspecting the emitted bundle's import graph. Estate's island is tiny, so the headline win here is the *mechanism*; a heavy island (a chart, an editor) defers its real weight.

## Consequences

- The wire contract is untouched: same manifest, same serialized `<script>`, same `IslandMount`. Byte-compat with every existing page.
- Eager islands are byte-for-byte unchanged in behavior and timing; only defs that opt into `load` change anything.
- A lazy island's mount is asynchronous by nature — tests that previously asserted a mount synchronously after `hydrateIslands` must settle one extra async hop (estate's auth-island test now documents this).
- `ssr: true` and lazy are mutually exclusive by construction. Code-splitting an ssr island would require the *server* to hold the component anyway, which erases the client-byte motivation; if a real need appears, it is a new ADR.
- The chunk's URL is implicit (relative ESM), which assumes chunks are served from the same directory as the entry. All current Keel serving paths do; a CDN layout that relocates chunks would need the bundler's `publicPath`, not a Keel change.
