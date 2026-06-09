/**
 * The app's routes.
 *
 * `resources("posts")` declares the seven RESTful routes for the collection —
 * here we lean on `GET /posts` (`posts#index`, the HTML page). A second explicit
 * route maps `GET /api/posts` to the JSON `posts#api` action, so the same data is
 * available as a page and as an API off one controller.
 */

import { Router } from "@keel/router";

export function buildRouter(): Router {
  const router = new Router();

  router.resources("posts");

  router.get("/api/posts", "posts#api", { as: "api_posts" });

  return router;
}
