# @usedocks/vite-plugin

Vite plugin for Docks content collections.

## Installation

```bash
npm install @usedocks/vite-plugin @usedocks/core
```

## Quick Start

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import { docks } from "@usedocks/vite-plugin";

export default defineConfig({
  plugins: [docks()],
});
```

Then import your content:

```typescript
import { getCollection } from "@usedocks/content";

const posts = getCollection("posts");
```

## Options

```typescript
docks({
  // Include raw markdown in output (default: true)
  rawMarkdown: true,
  // Enable bundle size warnings (default: false)
  bundleSize: true,
});
```

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
