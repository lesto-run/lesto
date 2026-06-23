/**
 * The blog UI: the index list at `/blog` and the single-post frame at
 * `/blog/<slug>`.
 *
 * Both reuse the global `SiteLayout` chrome and the `.prose` typography (custom CSS
 * in `app/styles/app.css`, since it styles build-time-rendered Markdown that utility
 * classes cannot reach); the surrounding shell + post list are Tailwind utilities.
 * The `make*` helpers close their data into a zero-prop component so the app can
 * register one static `.page()` per route with no loader.
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

/** The centered single-column reading frame shared by the index, post, and changelog. */
const SHELL = "max-w-[44rem] mx-auto pt-[4.5rem] pb-20 px-7 min-w-0";
const SHELL_H1 =
  "text-[clamp(2rem,4vw,2.6rem)] leading-[1.12] tracking-[-0.034em] font-semibold mb-2";
const LEDE = "text-muted text-[1.1rem] mb-9 tracking-[-0.012em]";

/** Format an ISO `YYYY-MM-DD` as "June 22, 2026" — by hand, so no timezone drift. */
export function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return iso;
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) return iso;
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

/** The reading-frame shell, exported so the changelog shares its exact spacing. */
export { SHELL, SHELL_H1, LEDE };

/** The blog index — every post, newest first, as a linked list. */
export function BlogIndex({ posts }: { posts: readonly BlogPost[] }): ReactElement {
  return (
    <main className={SHELL}>
      <h1 className={SHELL_H1}>Blog</h1>
      <p className={LEDE}>Notes from the people building Lesto.</p>
      <ul className="list-none m-0 p-0">
        {posts.map((post) => (
          <li className="py-[1.6rem] border-b border-line first:pt-2" key={post.route}>
            <time className="block text-faint text-[0.8rem] tracking-[0.01em]" dateTime={post.date}>
              {formatDate(post.date)}
            </time>
            <a
              href={post.route}
              className="inline-block my-[0.3rem] text-[1.22rem] font-[580] text-ink tracking-[-0.022em] hover:text-accent"
            >
              {post.title}
            </a>
            {post.description !== undefined ? (
              <p className="mt-[0.2rem] mb-0 text-muted tracking-[-0.01em]">{post.description}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  );
}

/** One rendered post: a back link, the date/author meta, then the Markdown body. */
function BlogPostPage({ post }: { post: BlogPost }): ReactElement {
  return (
    <main className={SHELL}>
      <p className="text-[0.88rem] mb-[1.4rem] [&_a]:text-muted [&_a:hover]:text-accent">
        <a href="/blog">← Blog</a>
      </p>
      <h1 className={SHELL_H1}>{post.title}</h1>
      <p className="text-faint text-[0.88rem] mb-8">
        <time dateTime={post.date}>{formatDate(post.date)}</time>
        {post.author !== undefined ? ` · ${post.author}` : null}
      </p>
      {/* post.html is sanitized by the content-markdown render pass at build time. */}
      <article className="prose" dangerouslySetInnerHTML={{ __html: post.html }} />
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
