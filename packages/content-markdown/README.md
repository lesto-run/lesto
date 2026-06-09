# @keel/content-markdown

Markdown rendering for Docks content collections.

## Installation

```bash
npm install @keel/content-markdown
```

## Quick Start

```typescript
import { render } from "@keel/content-markdown";

const result = await render("# Hello World");
console.log(result.html);
// <h1 id="hello-world">Hello World</h1>
```

## Features

- **Syntax highlighting** with Shiki
- **GitHub Flavored Markdown** support
- **Auto-generated heading IDs**
- **Copy buttons** for code blocks
- **Reading time** calculation
- **Heading extraction** for table of contents

## Render Options

```typescript
const result = await render(content, {
  syntaxHighlighting: true,
  copyButtons: true,
  sanitize: true,
});

result.html; // Rendered HTML
result.headings; // Extracted headings
result.readingTime; // { minutes, words }
```

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
