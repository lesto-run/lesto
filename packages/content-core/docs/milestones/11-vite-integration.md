# Milestone 11: Vite Plugin & Templates Migration

## Objective
Migrate `@usedocks/vite-plugin` and all Vite-based templates to the generator-based pipeline architecture and runtime API.

## Dependencies
- Milestone 8 (engine)
- Milestone 10 (cleanup complete)

## Background

The current vite-plugin uses APIs that no longer exist:
- `engine.updateFile()` - removed
- `getCollectionFromPath()` - never part of public API
- `roots` config property - replaced by `collections` with explicit `directory`

Following the pattern established in Next.js integration, the plugin and templates use the runtime API (`getEntry`, `getCollection`) and generated output (`.docks/generated`).

## Current State Analysis

### Vite Plugin Issues
| Issue | Current Code | Required Change |
|-------|--------------|-----------------|
| Non-existent import | `getCollectionFromPath` | Remove entirely |
| Non-existent method | `engine.updateFile()` | Use `engine.watch()` |
| Removed config | `roots` option | Use `resolveConfig()` |
| Legacy import mechanism | synchronous collection imports | Use runtime API |

### Templates
All templates should query content via `@usedocks/core` runtime APIs.

## Deliverables

### Package: `@usedocks/vite-plugin`
- [ ] `src/plugin.ts` - Complete rewrite
- [ ] `src/index.ts` - Update exports with re-exports from core

### Template: `vite-react`
- [ ] `docks.config.ts` - Migrate to array format
- [ ] `src/App.tsx` - Use runtime API with useEffect
- [ ] `src/vite-env.d.ts` - Update reference path
- [ ] `tsconfig.json` - Verify types inclusion

### Template: `vite-react-router`
- [ ] `docks.config.ts` - Create new config file
- [ ] `src/routes/home.tsx` - Use runtime API with loader
- [ ] `src/routes/post.tsx` - Use runtime API with loader
- [ ] `src/vite-env.d.ts` - Update reference path
- [ ] `tsconfig.json` - Add types inclusion

### Template: `tanstack-router`
- [ ] `docks.config.ts` - Create new config file
- [ ] `src/routes/index.tsx` - Use runtime API with route loader
- [ ] `src/routes/posts.$slug.tsx` - Use runtime API with route loader
- [ ] `src/vite-env.d.ts` - Update reference path
- [ ] `tsconfig.json` - Add types inclusion

### Template: `tanstack-start`
- [ ] `docks.config.ts` - Create new config file
- [ ] `src/routes/posts.tsx` - Use runtime API with server loader
- [ ] `src/routes/posts.$postId.tsx` - Use runtime API with server loader
- [ ] `src/vite-env.d.ts` - Update reference path
- [ ] `tsconfig.json` - Add types inclusion

---

## Implementation Details

### `packages/vite-plugin/src/plugin.ts` (Complete Rewrite)

```typescript
import path from "node:path";
import {
  createEngine,
  resolveConfig,
  type Engine,
  type EngineConfig,
  type AnyCollection,
  type ValidationMode,
} from "@usedocks/core";
import type { Plugin } from "vite";

const PLUGIN_NAME = "docks";

export interface DocksPluginConfig {
  /**
   * Enable debug logging.
   */
  debug?: boolean;

  /**
   * Working directory for content resolution.
   * Defaults to Vite's root.
   */
  cwd?: string;

  /**
   * Collection definitions (if not using config file).
   */
  collections?: AnyCollection[];

  /**
   * Validation mode.
   */
  mode?: ValidationMode;
}

function log(debug: boolean, ...args: unknown[]): void {
  if (debug) console.log("[docks]", ...args);
}

/**
 * Vite plugin for Docks content collections.
 * Compatible with Vite 5, 6, and 7.
 */
export function docks(pluginConfig: DocksPluginConfig = {}): Plugin {
  const { debug = false, ...engineOptions } = pluginConfig;

  let engine: Engine | null = null;
  let projectRoot: string;

  return {
    name: PLUGIN_NAME,

    async configResolved(resolvedConfig): Promise<void> {
      projectRoot = resolvedConfig.root;
      log(debug, `Resolved project root: ${projectRoot}`);
    },

    async buildStart(): Promise<void> {
      log(debug, "Initializing engine...");

      try {
        const cwd = engineOptions.cwd ?? projectRoot;
        const hasCollections = engineOptions.collections && engineOptions.collections.length > 0;

        let config: EngineConfig;

        if (hasCollections) {
          // Use programmatic config
          config = {
            cwd,
            collections: engineOptions.collections!,
            ...(engineOptions.mode && { mode: engineOptions.mode }),
          };
        } else {
          // Load from docks.config.{ts,js,mjs} file
          const resolved = await resolveConfig(cwd);
          config = {
            cwd,
            collections: resolved.collections,
            mode: engineOptions.mode ?? resolved.mode,
          };
        }

        engine = createEngine(config);
        await engine.scan();

        // Write types to node_modules/.docks
        const typesPath = await engine.writeTypes(
          path.join(projectRoot, "node_modules", ".docks")
        );
        log(debug, `Types written to: ${typesPath}`);
      } catch (error) {
        console.error("[docks] Failed to initialize:", error);
        throw error;
      }
    },

    configureServer(server): void {
      if (!engine) return;

      // Use engine's watch method for file changes
      const unwatch = engine.watch((event) => {
        log(debug, `File ${event.type}: ${event.path}`);

        // Regenerate types on content changes
        engine?.writeTypes(
          path.join(projectRoot, "node_modules", ".docks")
        ).catch((err) => {
          console.warn("[docks] Failed to write types:", err);
        });

        // Trigger full reload for content changes
        // This ensures the runtime API returns fresh data
        server.ws?.send({ type: "full-reload" });
      });

      // Cleanup on server close
      server.httpServer?.on("close", unwatch);
    },

    async buildEnd(): Promise<void> {
      log(debug, "Build complete");
    },
  };
}
```

### `packages/vite-plugin/src/index.ts` (Update)

```typescript
// Plugin
export { docks } from "./plugin";
export type { DocksPluginConfig } from "./plugin";

// Re-export from @usedocks/core for convenience
export {
  // Config
  defineCollection,
  defineConfig,

  // Runtime API
  getEntry,
  getCollection,
  getCollections,
  getRuntimeEngine,
  setRuntimeConfig,
  invalidateRuntimeEngine,

  // Pipeline (advanced)
  runPipeline,
  pipeline,
  createEngine,

  // Errors
  ValidationError,
  TransformError,
} from "@usedocks/core";

// Re-export types
export type {
  AnyCollection,
  Collection,
  CollectionConfig,
  CollectionData,
  CollectionRegistry,
  CollectionSchema,
  CollectionTransformed,
  Document,
  DocumentMeta,
  Engine,
  EngineConfig,
  Entry,
  InferEntry,
  InferOutput,
  PipelineOptions,
  PipelineResult,
  TransformContext,
  TransformFn,
  ValidationIssue,
  ValidationMode,
  WatchCallback,
  WatchEvent,
} from "@usedocks/core";
```

---

## Template: vite-react

### `templates/vite-react/docks.config.ts`

```typescript
import { defineConfig, defineCollection } from "@usedocks/core"
import { z } from "zod"

const PostSchema = z.object({
  title: z.string(),
  date: z.coerce.date(),
  description: z.string(),
  tags: z.array(z.string()).optional(),
})

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: PostSchema,
})

export default defineConfig({
  collections: [posts],
})
```

### `templates/vite-react/src/App.tsx`

```tsx
import { useEffect, useState } from "react";
import { getCollection, type Entry, type CollectionData } from "@usedocks/core";

type PostData = CollectionData<"posts">;
type Post = Entry<PostData>;

export default function App() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCollection("posts")
      .then((data) => {
        const sorted = [...data].sort(
          (a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime()
        );
        setPosts(sorted);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="container">Loading...</div>;
  }

  if (selectedPost) {
    return (
      <div className="container">
        <button className="back-button" onClick={() => setSelectedPost(null)}>
          &larr; Back to posts
        </button>
        <article className="post">
          <header>
            <h1>{selectedPost.data.title}</h1>
            <time>{formatDate(selectedPost.data.date)}</time>
            {selectedPost.data.tags && (
              <div className="tags">
                {selectedPost.data.tags.map((tag) => (
                  <span key={tag} className="tag">{tag}</span>
                ))}
              </div>
            )}
          </header>
          <div className="content">{selectedPost.content}</div>
        </article>
      </div>
    );
  }

  return (
    <div className="container">
      <header className="site-header">
        <h1>Docks Blog</h1>
        <p>A minimal blog starter built with Docks + Vite + React</p>
      </header>

      <main>
        <ul className="post-list">
          {posts.map((post) => (
            <li key={post.id} className="post-item">
              <article>
                <h2>
                  <button className="post-link" onClick={() => setSelectedPost(post)}>
                    {post.data.title}
                  </button>
                </h2>
                <time>{formatDate(post.data.date)}</time>
                {post.data.description && <p>{post.data.description}</p>}
                {post.data.tags && (
                  <div className="tags">
                    {post.data.tags.map((tag) => (
                      <span key={tag} className="tag">{tag}</span>
                    ))}
                  </div>
                )}
              </article>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(date));
}
```

### `templates/vite-react/src/vite-env.d.ts`

```typescript
/// <reference types="vite/client" />
/// <reference path="../node_modules/.docks/types.d.ts" />
```

### `templates/vite-react/tsconfig.json`

Ensure `include` has the types reference:
```json
{
  "compilerOptions": { ... },
  "include": [
    "src",
    "node_modules/.docks/types.d.ts"
  ]
}
```

---

## Template: vite-react-router

### `templates/vite-react-router/docks.config.ts` (Create)

```typescript
import { defineConfig, defineCollection } from "@usedocks/core"
import { z } from "zod"

const PostSchema = z.object({
  title: z.string(),
  date: z.coerce.date(),
  description: z.string(),
  tags: z.array(z.string()).optional(),
})

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: PostSchema,
})

export default defineConfig({
  collections: [posts],
})
```

### `templates/vite-react-router/src/routes/home.tsx`

```tsx
import { Link, useLoaderData } from "react-router";
import { getCollection, type Entry, type CollectionData } from "@usedocks/core";

type PostData = CollectionData<"posts">;
type Post = Entry<PostData>;

export async function loader() {
  const posts = await getCollection("posts");
  return posts.sort(
    (a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime()
  );
}

export default function Home() {
  const posts = useLoaderData() as Post[];

  return (
    <ul className="post-list">
      {posts.map((post) => (
        <li key={post.id} className="post-item">
          <article>
            <h2>
              <Link to={`/posts/${post.slug}`} className="post-link">
                {post.data.title}
              </Link>
            </h2>
            <time>{formatDate(post.data.date)}</time>
            {post.data.description && <p>{post.data.description}</p>}
            {post.data.tags && (
              <div className="tags">
                {post.data.tags.map((tag) => (
                  <span key={tag} className="tag">{tag}</span>
                ))}
              </div>
            )}
          </article>
        </li>
      ))}
    </ul>
  );
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(date));
}
```

### `templates/vite-react-router/src/routes/post.tsx`

```tsx
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { getEntry, type Entry, type CollectionData } from "@usedocks/core";

type PostData = CollectionData<"posts">;
type Post = Entry<PostData>;

export async function loader({ params }: LoaderFunctionArgs) {
  const post = await getEntry("posts", params.slug!);
  if (!post) {
    throw new Response("Not Found", { status: 404 });
  }
  return post;
}

export default function Post() {
  const post = useLoaderData() as Post;

  return (
    <article className="post">
      <Link to="/" className="back-link">
        &larr; Back to all posts
      </Link>

      <header>
        <h1>{post.data.title}</h1>
        <time>{formatDate(post.data.date)}</time>
        {post.data.tags && (
          <div className="tags">
            {post.data.tags.map((tag) => (
              <span key={tag} className="tag">{tag}</span>
            ))}
          </div>
        )}
      </header>

      <div className="content">{post.content}</div>
    </article>
  );
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(date));
}
```

### `templates/vite-react-router/src/main.tsx`

Update to use route loaders:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import Layout from "./routes/layout";
import Home, { loader as homeLoader } from "./routes/home";
import Post, { loader as postLoader } from "./routes/post";
import "./index.css";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Home />, loader: homeLoader },
      { path: "posts/:slug", element: <Post />, loader: postLoader },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
```

---

## Template: tanstack-router

### `templates/tanstack-router/docks.config.ts` (Create)

```typescript
import { defineConfig, defineCollection } from "@usedocks/core"
import { z } from "zod"

const PostSchema = z.object({
  title: z.string(),
  date: z.coerce.date(),
  description: z.string(),
  tags: z.array(z.string()).optional(),
})

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: PostSchema,
})

export default defineConfig({
  collections: [posts],
})
```

### `templates/tanstack-router/src/routes/index.tsx`

```tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { getCollection, type Entry, type CollectionData } from "@usedocks/core";

type PostData = CollectionData<"posts">;
type Post = Entry<PostData>;

export const Route = createFileRoute("/")({
  loader: async () => {
    const posts = await getCollection("posts");
    return posts.sort(
      (a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime()
    );
  },
  component: Home,
});

function Home() {
  const posts = Route.useLoaderData() as Post[];

  return (
    <ul className="post-list">
      {posts.map((post) => (
        <li key={post.id} className="post-item">
          <article>
            <h2>
              <Link to="/posts/$slug" params={{ slug: post.slug }} className="post-link">
                {post.data.title}
              </Link>
            </h2>
            <time>{formatDate(post.data.date)}</time>
            {post.data.description && <p>{post.data.description}</p>}
            {post.data.tags && (
              <div className="tags">
                {post.data.tags.map((tag) => (
                  <span key={tag} className="tag">{tag}</span>
                ))}
              </div>
            )}
          </article>
        </li>
      ))}
    </ul>
  );
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(date));
}
```

### `templates/tanstack-router/src/routes/posts.$slug.tsx`

```tsx
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { getEntry, type Entry, type CollectionData } from "@usedocks/core";

type PostData = CollectionData<"posts">;
type Post = Entry<PostData>;

export const Route = createFileRoute("/posts/$slug")({
  loader: async ({ params }) => {
    const post = await getEntry("posts", params.slug);
    if (!post) {
      throw notFound();
    }
    return post;
  },
  component: Post,
});

function Post() {
  const post = Route.useLoaderData() as Post;

  return (
    <article className="post">
      <Link to="/" className="back-link">
        &larr; Back to all posts
      </Link>

      <header>
        <h1>{post.data.title}</h1>
        <time>{formatDate(post.data.date)}</time>
        {post.data.tags && (
          <div className="tags">
            {post.data.tags.map((tag) => (
              <span key={tag} className="tag">{tag}</span>
            ))}
          </div>
        )}
      </header>

      <div className="content">{post.content}</div>
    </article>
  );
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(date));
}
```

---

## Template: tanstack-start

TanStack Start is an SSR framework, so loaders run on the server.

### `templates/tanstack-start/docks.config.ts` (Create)

```typescript
import { defineConfig, defineCollection } from "@usedocks/core"
import { z } from "zod"

const PostSchema = z.object({
  title: z.string(),
  date: z.coerce.date(),
  description: z.string(),
  tags: z.array(z.string()).optional(),
})

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: PostSchema,
})

export default defineConfig({
  collections: [posts],
})
```

### `templates/tanstack-start/src/routes/posts.tsx`

```tsx
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { getCollection, type Entry, type CollectionData } from "@usedocks/core";

type PostData = CollectionData<"posts">;
type Post = Entry<PostData>;

export const Route = createFileRoute("/posts")({
  loader: async () => {
    const posts = await getCollection("posts");
    return posts.sort(
      (a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime()
    );
  },
  component: PostsLayout,
});

function PostsLayout() {
  const posts = Route.useLoaderData() as Post[];

  return (
    <div className="flex gap-8">
      <aside className="w-64 shrink-0">
        <h2 className="mb-4 font-semibold text-gray-900">All Posts</h2>
        <nav>
          <ul className="space-y-2">
            {posts.map((post) => (
              <li key={post.id}>
                <Link
                  to="/posts/$postId"
                  params={{ postId: post.slug }}
                  className="block text-sm text-gray-600 hover:text-blue-600 [&.active]:font-medium [&.active]:text-blue-600"
                >
                  {post.data.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
```

### `templates/tanstack-start/src/routes/posts.$postId.tsx`

```tsx
import { createFileRoute, notFound } from "@tanstack/react-router";
import { getEntry, type Entry, type CollectionData } from "@usedocks/core";

type PostData = CollectionData<"posts">;
type Post = Entry<PostData>;

export const Route = createFileRoute("/posts/$postId")({
  loader: async ({ params }) => {
    const post = await getEntry("posts", params.postId);
    if (!post) {
      throw notFound();
    }
    return post;
  },
  component: PostComponent,
});

function PostComponent() {
  const post = Route.useLoaderData() as Post;

  return (
    <article className="rounded-lg bg-white p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{post.data.title}</h1>
        <time className="text-sm text-gray-500">{formatDate(post.data.date)}</time>
        {post.data.tags && (
          <div className="mt-3 flex flex-wrap gap-2">
            {post.data.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </header>

      <div className="prose text-gray-800 max-w-none whitespace-pre-wrap">
        {post.content}
      </div>
    </article>
  );
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(date));
}
```

---

## Tests

### `packages/vite-plugin/src/__tests__/plugin.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { docks } from "../plugin";

describe("docks plugin", () => {
  it("returns a vite plugin with correct name", () => {
    const plugin = docks();
    expect(plugin.name).toBe("docks");
  });

  it("has required lifecycle hooks", () => {
    const plugin = docks();
    expect(typeof plugin.configResolved).toBe("function");
    expect(typeof plugin.buildStart).toBe("function");
    expect(typeof plugin.configureServer).toBe("function");
  });

  it("accepts debug option", () => {
    const consoleSpy = vi.spyOn(console, "log");
    const plugin = docks({ debug: true });
    expect(plugin).toBeDefined();
    consoleSpy.mockRestore();
  });

  it("accepts collections option", () => {
    const plugin = docks({
      collections: [],
    });
    expect(plugin).toBeDefined();
  });

  it("accepts mode option", () => {
    const plugin = docks({
      mode: "development",
    });
    expect(plugin).toBeDefined();
  });
});
```

---

## Acceptance Criteria

### Plugin
- [ ] Uses `createEngine` and `resolveConfig` from `@usedocks/core`
- [ ] Uses `engine.watch()` for file change detection
- [ ] Types written to `node_modules/.docks/types.d.ts`
- [ ] HMR triggers full reload on content changes
- [ ] All tests pass

### Templates
- [ ] All 4 templates have `docks.config.ts` with new array format
- [ ] All templates use runtime API (`getCollection`, `getEntry`)
- [ ] All templates include generated types via `vite-env.d.ts`
- [ ] All templates build successfully
- [ ] All templates run in dev mode without errors

---

## Breaking Changes

1. **Legacy synchronous collection imports removed**: query via `getCollection()` / `getEntry()` instead
2. **Config format changed**: `collections` is now an array, not an object
3. **Collection requires explicit fields**: Must have `name`, `directory`, `include`
4. **Runtime API required**: Must use `getCollection()`/`getEntry()` with async/await
5. **Plugin options changed**: `roots` option removed entirely

---

## Migration Guide for Users

### Config File

**Before:**
```typescript
export default defineConfig({
  collections: {
    posts: defineCollection({
      schema: PostSchema,
    }),
  },
})
```

**After:**
```typescript
export default defineConfig({
  collections: [
    defineCollection({
      name: "posts",
      directory: "content/posts",
      include: "**/*.md",
      schema: PostSchema,
    }),
  ],
})
```

### Component Code (async with loader or useEffect)

For frameworks with loaders (React Router, TanStack):
```typescript
import { getCollection } from "@usedocks/core"

export async function loader() {
  return await getCollection("posts")
}

function Component() {
  const posts = useLoaderData()
  return <div>{posts.map(p => <Post key={p.id} post={p} />)}</div>
}
```

For plain React:
```typescript
import { useEffect, useState } from "react"
import { getCollection } from "@usedocks/core"

function Component() {
  const [posts, setPosts] = useState([])

  useEffect(() => {
    getCollection("posts").then(setPosts)
  }, [])

  return <div>{posts.map(p => <Post key={p.id} post={p} />)}</div>
}
```
