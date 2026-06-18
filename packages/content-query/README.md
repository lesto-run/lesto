# @lesto/content-query

Tiny fluent query API for typed collections (~520 bytes).

## Installation

```bash
npm install @lesto/content-query
```

## Quick Start

```typescript
import { query } from "@lesto/content-query";
import { getCollection } from "@lesto/content-content";

const posts = getCollection("posts");

const recent = query(posts)
  .where((p) => !p.draft)
  .sortBy("date", "desc")
  .limit(5)
  .all();
```

## Features

- **Tiny** - ~520 bytes gzipped
- **Type-safe** - Full TypeScript inference
- **Chainable** - Fluent API for filtering and sorting
- **Pagination** - Built-in pagination helpers

## API

```typescript
query(entries)
  .where((entry) => condition)    // Filter entries
  .sortBy("field", "asc" | "desc") // Sort by field
  .limit(n)                        // Limit results
  .offset(n)                       // Skip entries
  .paginate({ page, perPage })     // Paginate
  .all()                           // Get all results
  .first()                         // Get first result
```

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
