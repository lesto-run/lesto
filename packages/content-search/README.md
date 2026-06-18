# @lesto/content-search

Client-safe vector search for semantic content discovery.

## Installation

```bash
npm install @lesto/content-search
```

## Quick Start

`createSearch` takes the index URL as a string and resolves to a client. The
client queries by embedding vector (this package is embedding-free at runtime —
generate the query embedding with `@lesto/content-embeddings` or an embed API):

```typescript
import { createSearch } from "@lesto/content-search";

const search = await createSearch("/.docks/search-index.json");

// `queryEmbedding` is a number[] (e.g. from POST /api/embed)
const results = search.query(queryEmbedding, {
  limit: 5,
  threshold: 0.5,
});

results.forEach((r) => {
  console.log(r.id, r.score);
});
```

The client also exposes `findSimilar(id, k)`, `getEntries()`, and
`getByCollection(collection)`.

## Features

- **Semantic search** - Find content by meaning, not just keywords
- **Browser-safe** - Runs entirely client-side
- **Zero dependencies** - Lightweight and fast
- **Progressive loading** - Load index chunks on demand
- **Binary quantization** - 32x smaller indexes

## React Hook

`useSearch` takes `indexPath` (not `indexUrl`) and manages query embedding,
debouncing, and keyword/semantic blending internally. It exposes `isSearching`
and `isReady` (there is no `isLoading`):

```tsx
import { useSearch } from "@lesto/content-search/react";

function SearchBox() {
  const { results, search, isSearching, isReady } = useSearch({
    indexPath: "/.docks/search-index.json",
  });

  return (
    <input
      disabled={!isReady}
      onChange={(e) => search(e.target.value)}
    />
  );
}
```

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
