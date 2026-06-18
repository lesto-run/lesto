# @volo/content-lint

Content linting rules for Docks.

## Installation

```bash
npm install @volo/content-lint
```

## Quick Start

```bash
# Lint content files
npx docks lint content/**/*.md
```

## Rules

Built-in rules check for:

- **Terminology** - Use preferred terms
- **Style** - Avoid passive voice, weasel words
- **Readability** - Sentence length, complexity
- **Accessibility** - Alt text, link text
- **Consistency** - Heading levels, formatting

## Configuration

```typescript
// docks.config.ts
export default defineConfig({
  voice: {
    terminology: [
      { incorrect: "click here", preferred: "select" },
      { incorrect: "utilize", preferred: "use" },
    ],
  },
});
```

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
