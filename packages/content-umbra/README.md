# @lesto/content-umbra

Fast frontmatter parsing for markdown files.

## Installation

```bash
npm install @lesto/content-umbra
```

## Quick Start

```typescript
import { parseFrontmatter } from "@lesto/content-umbra";

const content = `---
title: Hello World
date: 2024-01-15
---

# Hello World

This is the content.`;

const result = parseFrontmatter(content);
console.log(result.data);
// { title: "Hello World", date: "2024-01-15" }
console.log(result.content);
// "# Hello World\n\nThis is the content."
```

## Features

- **Fast** - 2x faster than gray-matter
- **YAML & JSON** - Supports both frontmatter formats
- **Zero config** - Works out of the box
- **Excerpt extraction** - Built-in excerpt support

## API

```typescript
// Parse frontmatter
const { data, content, excerpt } = parseFrontmatter(markdown);

// Stringify frontmatter
const output = stringify({ title: "Hello" }, "# Content");

// Check for frontmatter
const hasFm = hasFrontmatter(markdown);

// Extract excerpt
const excerpt = extractExcerpt(content, 160);
```

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
