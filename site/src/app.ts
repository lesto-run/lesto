/**
 * Assemble the documentation site as a Lesto app.
 *
 * The content pipeline runs once here, at build time, and every resulting doc
 * becomes one `static: true` page whose component is fully bound to that doc —
 * no per-request loader, because a docs page has nothing to resolve at request
 * time. `lesto build` then prerenders each of these routes to an HTML file (see
 * `build.ts` and `lesto.sites.ts`), and the edge serves those files directly.
 *
 * The kernel requires a database handle, so we open an in-memory SQLite one to
 * satisfy it — but no route touches it. That handle only ever exists under Node
 * (dev, prerender); it is never bundled into the Cloudflare Worker, which serves
 * static assets and never boots this app.
 */

import type { LestoAppConfig } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import { lesto } from "@lesto/web";

import { buildNav, loadDocs } from "./content";
import { makeDocPage } from "./ui/doc-page";
import { DocsLayout } from "./ui/layout";

export async function buildAppConfig(): Promise<LestoAppConfig> {
  const { db } = await openSqlite();
  const docs = await loadDocs();
  const nav = buildNav(docs);

  // The search island's client bundle (built into out/docs/client.js); every
  // page emits its module tag in <head>, which mounts the box on load.
  let app = lesto().client("/client.js").layout(DocsLayout);
  for (const doc of docs) {
    app = app.page(doc.route, {
      static: true,
      component: makeDocPage(doc, nav),
      metadata: () => ({
        title: `${doc.title} · Lesto`,
        ...(doc.description === undefined ? {} : { description: doc.description }),
      }),
    });
  }

  // No migrations: the content lives in files, rendered at build time; the
  // database is present only because the kernel's config requires one.
  return { db, app, migrations: "skip" };
}
