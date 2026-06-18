# @volo/content-core

Schema-driven content engine for markdown in TypeScript applications.

## Installation

```bash
npm install @volo/content-core zod
```

## Quick Start

```typescript
import { defineConfig, defineCollection } from "@volo/content-core";
import { z } from "zod";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
  }),
});

export default defineConfig({
  collections: [posts],
});
```

## Features

- **Type-safe schemas** with Zod validation
- **Auto-rendered HTML** from markdown
- **Computed fields** (word count, reading time, excerpts)
- **Taxonomies** for organizing content
- **References** between collections
- **Workflow states** (draft, scheduled, published)

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
