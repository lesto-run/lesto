# @keel/content-prose

Writing style analysis and prose linting for content.

## Installation

```bash
npm install @keel/content-prose
```

## Quick Start

```typescript
import { analyze } from "@keel/content-prose";

const result = analyze("The CEO will leverage synergies.");

console.log(result.issues);
// [
//   { type: "jargon", word: "leverage", suggestion: "use" },
//   { type: "jargon", word: "synergies", suggestion: "collaboration" }
// ]
```

## Features

- **Weasel words** - Detect vague or imprecise language
- **Hedge words** - Find words that weaken statements
- **Cliches** - Identify overused phrases
- **Filler words** - Remove unnecessary words
- **Jargon** - Simplify corporate speak

## Configuration

```typescript
import { configure } from "@keel/content-prose/config";

const analyzer = configure({
  severity: "warning",
  ignore: ["synergy"],
});
```

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
