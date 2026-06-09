# @keel/content-embeddings

Build-time embedding generation for semantic search.

## Installation

```bash
npm install @keel/content-embeddings
```

## Quick Start

```typescript
import { generateEmbeddings, serializeSearchIndex } from "@keel/content-embeddings";

// Generate embeddings for your content
const entries = [
  { id: "post-1", text: "Getting started with Docks" },
  { id: "post-2", text: "Advanced patterns and techniques" },
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
  batchSize: 50, // Process in batches
  onProgress: (done, total) => {
    console.log(`${done}/${total} entries processed`);
  },
});
```

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
