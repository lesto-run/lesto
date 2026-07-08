# @lesto/cache

> A TTL cache with pluggable stores and an injected clock — in-memory or SQL-backed.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/cache
```

```ts
import { Cache, MemoryStore } from "@lesto/cache";

const cache = new Cache({ store: new MemoryStore() });

// Read-through: computes + caches on a miss, replays on a hit.
const user = await cache.fetch("user:1", () => loadUser(1), { ttlMs: 60_000 });

// `remember` is the single-flight variant: concurrent misses for one key
// share ONE compute instead of stampeding the origin.
const report = await cache.remember("report:1", () => buildReport(1), { ttlMs: 60_000 });
```

Expiry policy lives in one place; the store just remembers entries. Swap
`new MemoryStore()` for `sqlStore(db)` (after `installCacheSchema(db)`) to persist
across restarts and share across workers — every other behavior is identical.

[Docs](https://docs.lesto.run) · [Example](../../examples/cache)
