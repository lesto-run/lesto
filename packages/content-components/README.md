# @lesto/content-components

HTML rendering components for Docks content collections.

## Installation

```bash
npm install @lesto/content-components
```

## Quick Start

### React

```tsx
import { Content } from "@lesto/content-components/react";

function Post({ post }) {
  return <Content html={post.rendered.html} />;
}
```

### Vue

```vue
<script setup>
import { Content } from "@lesto/content-components/vue";
</script>

<template>
  <Content :html="post.rendered.html" />
</template>
```

### Svelte

```svelte
<script>
import { Content } from "@lesto/content-components/svelte";
</script>

<Content html={post.rendered.html} />
```

## Features

- **Framework agnostic** - React, Vue, Svelte support
- **Safe rendering** - Sanitized HTML output
- **Copy buttons** - Auto-added to code blocks
- **Styling** - Works with any CSS framework

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
