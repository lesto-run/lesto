/**
 * The PostsController — the far end of the request round-trip.
 *
 * Two actions over the same data:
 *   - `index` queries every Post and renders an HTML page by composing a UI tree
 *     against the app registry, SSR'd by `renderTree`.
 *   - `api` returns the same posts as JSON.
 *
 * Neither action knows about HTTP or the database driver: it asks the ORM for
 * rows and hands the web layer a response built by a content-type-named helper.
 */

import { Controller } from "@keel/web";
import type { KeelResponse } from "@keel/web";
import type { UiNode } from "@keel/ui";

import { Post } from "./post";
import { registry } from "./registry";

export class PostsController extends Controller {
  index(): KeelResponse {
    const posts = Post.order("id", "asc").all();

    const tree: UiNode = {
      type: "Page",
      props: { title: "The Keel Blog" },
      children: posts.map((post) => ({
        type: "PostCard",
        props: {
          title: String(post.get("title")),
          body: String(post.get("body")),
        },
      })),
    };

    return this.renderTree(registry, tree);
  }

  api(): KeelResponse {
    const posts = Post.order("id", "asc")
      .all()
      .map((post) => post.toJSON());

    return this.json({ posts });
  }
}
