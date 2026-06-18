# @lesto/content-embeddings

Build-time embedding generation for semantic search.

## Installation

```bash
npm install @lesto/content-embeddings
```

## Quick Start

```typescript
import { generateEmbeddings, serializeSearchIndex } from "@lesto/content-embeddings";

// Generate embeddings for your content.
// Each entry needs id, slug, and collection; title/content are optional and
// are what gets embedded.
const entries = [
  { id: "post-1", slug: "getting-started", collection: "blog", title: "Getting started with Docks" },
  { id: "post-2", slug: "advanced-patterns", collection: "blog", title: "Advanced patterns and techniques" },
];

const results = await generateEmbeddings(entries);

// Serialize for client-side search
const index = serializeSearchIndex(results);
await Bun.write("public/search-index.json", index);
```

## Features

- **Local model** - Uses Hugging Face Transformers
- **Caching** - Embeddings are cached for fast rebuilds
- **Binary quantization** - 32x compression with minimal quality loss
- **Progressive indexes** - Split into tiers for faster loading

## Configuration

```typescript
const results = await generateEmbeddings(entries, {
  maxTextLength: 8192, // Truncate long content before embedding
  snippetLength: 200, // Snippet length stored for result display
  onProgress: ({ current, total, entry }) => {
    console.log(`${current}/${total} processed (${entry})`);
  },
});
```

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
