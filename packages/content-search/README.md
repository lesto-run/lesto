# @keel/content-search

Client-safe vector search for semantic content discovery.

## Installation

```bash
npm install @keel/content-search
```

## Quick Start

```typescript
import { createSearch } from "@keel/content-search";

const search = createSearch({
  indexUrl: "/.docks/search-index.json",
});

const results = await search.search("how to get started", {
  limit: 5,
  threshold: 0.5,
});

results.forEach((r) => {
  console.log(r.id, r.score);
});
```

## Features

- **Semantic search** - Find content by meaning, not just keywords
- **Browser-safe** - Runs entirely client-side
- **Zero dependencies** - Lightweight and fast
- **Progressive loading** - Load index chunks on demand
- **Binary quantization** - 32x smaller indexes

## React Hook

```typescript
import { useSearch } from "@keel/content-search/react";

function SearchBox() {
  const { results, search, isLoading } = useSearch({
    indexUrl: "/.docks/search-index.json",
  });

  return (
    <input onChange={(e) => search(e.target.value)} />
  );
}
```

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
