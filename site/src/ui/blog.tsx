/**
 * The blog UI: the index list at `/blog` and the single-post frame at
 * `/blog/<slug>`.
 *
 * Both reuse the global `DocsLayout` chrome (header, search, footer) and the
 * `.docs-article` typography for rendered Markdown — they differ only in the
 * centered, single-column `.prose-shell` frame, which has no docs sidebar. Like
 * `makeDocPage`, the `make*` helpers close their data into a zero-prop component
 * so the app can register one static `.page()` per route with no loader.
 */

import type { ReactElement } from "react";

import type { BlogPost } from "../content";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Format an ISO `YYYY-MM-DD` as "June 22, 2026" — by hand, so no timezone drift. */
export function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return iso;
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) return iso;
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

/** The blog index — every post, newest first, as a linked list. */
export function BlogIndex({ posts }: { posts: readonly BlogPost[] }): ReactElement {
  return (
    <main className="prose-shell">
      <h1>Blog</h1>
      <p className="prose-lede">Notes from the people building Lesto.</p>
      <ul className="post-list">
        {posts.map((post) => (
          <li key={post.route}>
            <time dateTime={post.date}>{formatDate(post.date)}</time>
            <a href={post.route} className="post-link">
              {post.title}
            </a>
            {post.description !== undefined ? <p>{post.description}</p> : null}
          </li>
        ))}
      </ul>
    </main>
  );
}

/** One rendered post: a back link, the date/author meta, then the Markdown body. */
function BlogPostPage({ post }: { post: BlogPost }): ReactElement {
  return (
    <main className="prose-shell">
      <p className="prose-back">
        <a href="/blog">← Blog</a>
      </p>
      <p className="post-meta">
        <time dateTime={post.date}>{formatDate(post.date)}</time>
        {post.author !== undefined ? ` · ${post.author}` : null}
      </p>
      {/* post.html is sanitized by the content-markdown render pass at build time. */}
      <article className="docs-article" dangerouslySetInnerHTML={{ __html: post.html }} />
    </main>
  );
}

/** Bind the post list into a zero-prop index page component. */
export function makeBlogIndex(posts: readonly BlogPost[]): () => ReactElement {
  return function BoundBlogIndex(): ReactElement {
    return <BlogIndex posts={posts} />;
  };
}

/** Bind one post into a zero-prop page component for static registration. */
export function makeBlogPost(post: BlogPost): () => ReactElement {
  return function BoundBlogPost(): ReactElement {
    return <BlogPostPage post={post} />;
  };
}
