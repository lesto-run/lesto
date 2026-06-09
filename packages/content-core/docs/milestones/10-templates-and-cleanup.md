# Milestone 10: Templates & Cleanup

## Objective
Update templates to use new API and remove deprecated files.

## Dependencies
- Milestone 9 (Next.js integration)

## Deliverables
- [ ] Update `templates/next/docks.config.ts`
- [ ] Update `templates/next/app/blog/*.tsx`
- [ ] Update `templates/next/tsconfig.json`
- [ ] Delete deprecated files from @usedocks/core
- [ ] Final verification

## Files to Modify

### `templates/next/docks.config.ts`

```typescript
import { defineConfig, defineCollection } from "@usedocks/core";
import { z } from "zod";

// Define schema separately for type inference
const PostSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  publishedAt: z.coerce.date(),
  draft: z.boolean().default(false),
});

// Define transform output type explicitly
type PostTransformed = {
  readingTime: number;
  excerpt: string;
};

// Create collection with explicit type parameters
const posts = defineCollection<typeof PostSchema, PostTransformed>({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  schema: PostSchema,
  transform: (doc, ctx) => {
    // Skip drafts in production
    if (doc.data.draft && process.env.NODE_ENV === "production") {
      ctx.skip();
    }

    const words = doc.content.trim().split(/\s+/).length;

    return {
      readingTime: Math.ceil(words / 200),
      excerpt: doc.content.slice(0, 200).trim() + (doc.content.length > 200 ? "..." : ""),
    };
  },
});

export default defineConfig({
  collections: [posts],
});
```

### `templates/next/app/blog/page.tsx`

```typescript
import Link from "next/link";
import { getCollection } from "@usedocks/core";

export default async function BlogPage() {
  // Type-safe: Entry<PostData, PostTransformed>[]
  const posts = await getCollection("posts");

  return (
    <div>
      <h1>Blog</h1>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {posts.map((post) => (
          <li key={post.id} style={{ marginBottom: "1.5rem" }}>
            <Link
              href={`/blog/${post.slug}`}
              style={{ fontSize: "1.25rem", fontWeight: "bold" }}
            >
              {post.data.title}
            </Link>
            {post.data.description && (
              <p style={{ margin: "0.5rem 0 0", color: "#666" }}>
                {post.data.description}
              </p>
            )}
            {post.transformed?.readingTime && (
              <p style={{ margin: "0.25rem 0 0", color: "#999", fontSize: "0.875rem" }}>
                {post.transformed.readingTime} min read
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### `templates/next/app/blog/[slug]/page.tsx`

```typescript
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntry, getCollection } from "@usedocks/core";

interface PageProps {
  params: Promise<{ slug: string }>;
}

function formatDate(date: Date | string | number | null | undefined): string | null {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

export async function generateStaticParams() {
  const posts = await getCollection("posts");
  return posts.map((post) => ({
    slug: post.slug,
  }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = await getEntry("posts", slug);

  if (!post) return {};

  return {
    title: post.data.title,
    description: post.data.description,
  };
}

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params;
  const post = await getEntry("posts", slug);

  if (!post) {
    notFound();
  }

  const publishedDate = formatDate(post.data.publishedAt);

  return (
    <article>
      <header style={{ marginBottom: "2rem" }}>
        <h1>{post.data.title}</h1>
        {post.data.description && (
          <p style={{ fontSize: "1.25rem", color: "#666" }}>
            {post.data.description}
          </p>
        )}
        <div style={{ color: "#999", fontSize: "0.875rem" }}>
          {publishedDate && <time>{publishedDate}</time>}
          {publishedDate && post.transformed?.readingTime && " · "}
          {post.transformed?.readingTime && (
            <span>{post.transformed.readingTime} min read</span>
          )}
        </div>
      </header>
      <div style={{ lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
        {post.content}
      </div>
      <footer style={{ marginTop: "2rem", paddingTop: "1rem", borderTop: "1px solid #eee" }}>
        <Link href="/blog">&larr; Back to blog</Link>
      </footer>
    </article>
  );
}
```

### `templates/next/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": [
    "next-env.d.ts",
    ".docks/types.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts"
  ],
  "exclude": ["node_modules"]
}
```

## Files to Delete

### From `@usedocks/core`

- `packages/core/src/virtual.ts` - No longer needed
- `packages/core/src/scanner.ts` - Replaced by pipeline stages

### From `@usedocks/next`

- `packages/next/src/loader.ts` - No longer needed
- `packages/next/src/engine-store.ts` - Replaced by simplified plugin
- `packages/next/src/constants.ts` - No longer needed
- `packages/next/src/utils.ts` - Inlined

### From `templates/next`

- `templates/next/test-types.ts` - No longer needed

## Final Verification Checklist

### Build Verification
- [ ] `@usedocks/core` builds without errors
- [ ] `@usedocks/next` builds without errors
- [ ] Template project builds without errors

### Type Verification
- [ ] `getCollection("posts")` returns typed array
- [ ] `getEntry("posts", "slug")` returns typed entry
- [ ] Transform output is typed correctly
- [ ] Schema types are correctly inferred

### Runtime Verification
- [ ] Content is scanned correctly
- [ ] Types are generated to `.docks/types.d.ts`
- [ ] Watch mode detects changes
- [ ] Blog pages render correctly

### Documentation
- [ ] Update any relevant README files
- [ ] Remove references to legacy module-based imports
- [ ] Document new config format

## Acceptance Criteria

- [ ] Template uses new explicit collection format
- [ ] Template imports from `@usedocks/core`
- [ ] tsconfig includes `.docks/types.d.ts`
- [ ] All deprecated files deleted
- [ ] Full e2e test passes
- [ ] Build and dev both work
