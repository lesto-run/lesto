# @volo/content-mdx

MDX compilation and React components for Docks.

## Installation

```bash
npm install @volo/content-mdx react react-dom
```

## Quick Start

```typescript
import { MDXContent } from "@volo/content-mdx/components";
import { getEntry } from "@volo/content-content";

const doc = getEntry("docs", "introduction");

function DocPage() {
  return (
    <MDXContent
      entry={doc}
      components={{ Alert, Callout }}
    />
  );
}
```

## Custom Components

Pass React components to MDX content:

```typescript
// components.tsx
export function Alert({ type, children }) {
  return <div className={`alert ${type}`}>{children}</div>;
}

// page.tsx
<MDXContent
  entry={doc}
  components={{ Alert }}
/>
```

Use in MDX:

```mdx
<Alert type="warning">
  This is a warning!
</Alert>
```

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
