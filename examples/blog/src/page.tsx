/**
 * The blog's pages — plain React components.
 *
 * Where the old app composed a `UiNode` tree against a registry and SSR'd it
 * with `renderTree`, a page is now an ordinary React component. The `.page`
 * renderer (see `@keel/web`) runs the loader, wraps the component in the app's
 * layouts, and streams the whole `<html>` document shell-first — the registry
 * path is reserved for DB-driven content, not a hand-authored view like this.
 */

import type { ReactElement } from "react";

import type { Post } from "./post";

/** The blog index: a titled list of post cards. */
export function BlogPage({ posts }: { posts: Post[] }): ReactElement {
  return (
    <main>
      <h1>The Keel Blog</h1>

      <section>
        {posts.map((post) => (
          <article key={post.id}>
            <h2>{post.title}</h2>

            <p>{post.body}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
