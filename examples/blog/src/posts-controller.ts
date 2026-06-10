/**
 * The PostsController — the far end of the request round-trip.
 *
 * Two actions over the same data:
 *   - `index` queries every Post and renders an HTML page by composing a
 *     UI tree against the app registry, SSR'd by `renderTree`.
 *   - `api` returns the same posts as JSON.
 *
 * Built through a factory so the controller closes over the {@link Db} the
 * app boot wires up — no module-scoped database global. Mirrors the
 * `@keel/identity` and `@keel/mailing-lists` shape.
 */

import { Controller } from "@keel/web";
import type { ControllerClass, KeelResponse } from "@keel/web";
import type { Db } from "@keel/db";
import type { UiNode } from "@keel/ui";

import { listPosts } from "./post";
import { registry } from "./registry";

export function buildControllers(db: Db): { posts: ControllerClass } {
  class PostsController extends Controller {
    async index(): Promise<KeelResponse> {
      const posts = await listPosts(db);

      const tree: UiNode = {
        type: "Page",
        props: { title: "The Keel Blog" },
        children: posts.map((post) => ({
          type: "PostCard",
          props: { title: post.title, body: post.body },
        })),
      };

      return this.renderTree(registry, tree);
    }

    async api(): Promise<KeelResponse> {
      return this.json({ posts: await listPosts(db) });
    }
  }

  return { posts: PostsController as ControllerClass };
}
