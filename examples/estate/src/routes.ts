/**
 * The routes for both zones, declared on one router.
 *
 * The marketing routes (`/`, `/about`) exist so the build can prerender them;
 * at serve time they are answered from static files. The `/mls/*` routes are the
 * live, dynamic app — including the session endpoint the marketing island calls.
 */

import { Router } from "@keel/router";

export const router = new Router()
  .get("/", "marketing#home")
  .get("/about", "marketing#about")
  .get("/mls", "mls#index")
  .get("/mls/api/session", "mls#session")
  .post("/mls/api/sign-in", "mls#signIn")
  .post("/mls/api/sign-out", "mls#signOut")
  .get("/mls/saved", "mls#saved");
