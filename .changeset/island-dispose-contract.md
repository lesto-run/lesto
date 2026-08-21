---
"@lesto/ui": minor
---

Islands can now be taken down: `MountFn` returns a `Disposer`, `hydrateIslands` retains it per container, and soft navigation (plus the `lesto dev` page refresh) disposes what its swap detaches.

This closes a shipped leak. The swap was a bare `replaceChildren`, so every navigation orphaned a React root with live effects — and a `useQuery` `refetchInterval` / focus / reconnect registration kept firing against DOM no user could see, for the life of the tab. A layout-preserving partial swap still keeps the preserved outer layout's islands mounted, which is the point of the partial swap.

New on `@lesto/ui/client`: the `Disposer` type, `islandDisposer(container)` (the caller-held teardown handle — a second call raises the new coded `UI_ISLAND_ALREADY_DISPOSED`), and `disposeDetachedIslands()` (what an app that swaps DOM itself should call after detaching).

**Breaking for an injected mount.** `MountFn` returned `void` and now returns a required `Disposer`. Only code passing `options.mount` to `hydrateIslands` is affected — nothing in this repo outside `@lesto/ui`'s own tests does. A mount with nothing to tear down returns `() => undefined`.
