/**
 * Assemble the marketing site as a Lesto app.
 *
 * The content pipeline runs once here, at build time. The landing page and the
 * use-cases showcase are hand-built React; the blog and changelog are Markdown
 * rendered by `@lesto/content-*`. Every route becomes one `static: true` page
 * whose component is fully bound — no per-request loader, because a marketing
 * page has nothing to resolve at request time. `lesto build` then prerenders each
 * route to an HTML file (see `build.ts` and `lesto.sites.ts`), and the edge
 * serves those files directly.
 *
 * The kernel requires a database handle, so we open an in-memory SQLite one to
 * satisfy it — but no route touches it. That handle only ever exists under Node
 * (dev, prerender); it is never bundled into the Cloudflare Worker, which serves
 * static assets and never boots this app.
 */

import type { LestoAppConfig } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import type { PageMetadata } from "@lesto/web";
import { lesto } from "@lesto/web";

import { type BlogPost, loadBlog, loadChangelog } from "./content";
import { canonicalUrl, SITE_URL } from "./site";
import { makeBlogIndex, makeBlogPost } from "./ui/blog";
import { makeChangelog } from "./ui/changelog";
import { Landing } from "./ui/landing";
import { SiteLayout } from "./ui/layout";
import { makeUseCases } from "./ui/use-cases";

// Re-exported for the build, which imports the canonical origin from the app.
export { canonicalUrl, SITE_URL };

/** The social-preview image every page advertises (emitted by `build.ts`). */
const OG_IMAGE = `${SITE_URL}/og.svg`;

/**
 * The full `<head>` metadata for a page: the title, description, the Open Graph +
 * Twitter card block (so a shared link renders a rich preview, not a blank card),
 * a canonical link, and the favicon. The og/twitter tags flow through
 * `PageMetadata.meta` as typed `MetaSpec`s — `@lesto/web` renders them into the
 * document head, so this stays declarative and HTML-escaped.
 */
export function seoMetadata(input: {
  title: string;
  description?: string;
  route: string;
  type: "website" | "article";
}): PageMetadata {
  const url = canonicalUrl(input.route);

  const meta: PageMetadata["meta"] = [
    { property: "og:site_name", content: "Lesto" },
    { property: "og:title", content: input.title },
    { property: "og:type", content: input.type },
    { property: "og:url", content: url },
    { property: "og:image", content: OG_IMAGE },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: input.title },
    { name: "twitter:image", content: OG_IMAGE },
    ...(input.description === undefined
      ? []
      : [
          { property: "og:description", content: input.description },
          { name: "twitter:description", content: input.description },
        ]),
  ];

  return {
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    meta,
    links: [
      { rel: "canonical", href: url },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  };
}

/** Head metadata for one blog post — a thin wrapper over {@link seoMetadata}. */
function postMetadata(post: BlogPost): PageMetadata {
  return seoMetadata({
    title: `${post.title} · Lesto`,
    ...(post.description === undefined ? {} : { description: post.description }),
    route: post.route,
    type: "article",
  });
}

export async function buildAppConfig(): Promise<LestoAppConfig> {
  const { db } = await openSqlite();
  const [posts, releases] = await Promise.all([loadBlog(), loadChangelog()]);

  // The islands' client bundle (built into out/www/client.js); every page emits
  // its module tag in <head>, which boots the headless islands on load.
  let app = lesto()
    .client("/client.js")
    .layout(SiteLayout)
    .page("/", {
      static: true,
      component: Landing,
      metadata: () =>
        seoMetadata({
          title: "Lesto — Batteries-included. Agent-native.",
          description:
            "The full-stack TypeScript framework you can drive from Claude, the CLI, or code. Queue, auth, cache, workflows, email, and admin in the box, on one database, deployable to the edge.",
          route: "/",
          type: "website",
        }),
    })
    .page("/use-cases", {
      static: true,
      component: makeUseCases(),
      metadata: () =>
        seoMetadata({
          title: "Use cases · Lesto",
          description: "What you can build with Lesto — grounded in the runnable examples gallery.",
          route: "/use-cases",
          type: "website",
        }),
    });

  // The blog: an index at /blog and one page per post at /blog/<slug>.
  app = app.page("/blog", {
    static: true,
    component: makeBlogIndex(posts),
    metadata: () =>
      seoMetadata({
        title: "Blog · Lesto",
        description: "Notes from the people building Lesto.",
        route: "/blog",
        type: "website",
      }),
  });
  for (const post of posts) {
    app = app.page(post.route, {
      static: true,
      component: makeBlogPost(post),
      metadata: () => postMetadata(post),
    });
  }

  // The changelog: every release on one page.
  app = app.page("/changelog", {
    static: true,
    component: makeChangelog(releases),
    metadata: () =>
      seoMetadata({
        title: "Changelog · Lesto",
        description: "Notable changes to Lesto, newest first.",
        route: "/changelog",
        type: "website",
      }),
  });

  // No migrations: the content lives in files, rendered at build time; the
  // database is present only because the kernel's config requires one.
  return { db, app, migrations: "skip" };
}
