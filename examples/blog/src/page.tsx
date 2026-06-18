/**
 * The blog's pages — plain React components.
 *
 * Where the old app composed a `UiNode` tree against a registry and SSR'd it
 * with `renderTree`, a page is now an ordinary React component. The `.page`
 * renderer (see `@volo/web`) runs the loader, wraps the component in the app's
 * layouts, and streams the whole `<html>` document shell-first — the registry
 * path is reserved for DB-driven content, not a hand-authored view like this.
 */

import type { ReactElement } from "react";

import ReactionsIsland from "../app/islands/reactions";
import type { Post } from "./post";

/**
 * The blog index: a titled list of post cards, plus the Reactions island.
 *
 * `<ReactionsIsland />` is the canonical island (ADR 0012): an `ssr: true` island
 * whose `counts` data is resolved at render and inlined. It takes no props here —
 * its only prop (`counts`) is supplied by the framework from `reactionsSource`,
 * which the typed `defineIsland` (review F8) reflects: the JSX needs no `counts`.
 */
export function BlogPage({ posts }: { posts: Post[] }): ReactElement {
  return (
    <main>
      <h1>The Volo Blog</h1>

      <ReactionsIsland />

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
