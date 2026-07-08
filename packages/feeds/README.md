# @lesto/feeds

> RSS 2.0 and Atom 1.0 feed generation — pure XML string builders, no deps.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/feeds
```

```ts
import { rss, atom } from "@lesto/feeds";

const xml = rss(
  { title: "Lesto Blog", link: "https://lesto.run/blog" },
  [{ title: "Hello", link: "https://lesto.run/blog/hello" }],
);
```

The same `{ FeedMeta, FeedItem[] }` feeds both `rss(...)` and `atom(...)`; all
text is XML-escaped. `FeedMeta`/`FeedItem` require only `title` and `link` each —
everything else is optional or synthesized.

[Docs](https://docs.lesto.run) · [Example](../../examples/feeds)
