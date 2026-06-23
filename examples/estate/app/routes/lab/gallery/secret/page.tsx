/**
 * The guarded "secret listing" page — registered at `/lab/gallery/secret` because
 * it lives at `app/routes/lab/gallery/secret/page.tsx` (ADR 0023, dx-parity R2).
 *
 * Its sibling `middleware.ts` runs BEFORE this page's `load`: a visitor without the
 * `?key=jade` pass is redirected to the gallery and never reaches this component;
 * one WITH the pass arrives here, and the guard's `c.set("agent", …)` is readable
 * from `load` via `c.get(...)` — context augmentation flowing guard → loader → view.
 * The page itself stays an ordinary `PageDef`; the guard is invisible to it.
 */

import type { ReactNode } from "react";

import { Link } from "@lesto/ui";
import type { Context, PageDef, PageProps } from "@lesto/web";

// The value the co-located `middleware.ts` augmented onto the context. The loader
// reads it the same way it reads any request-scoped var — the guard ran first, so
// it is present. Pulled out as a `const` so the component's props are INFERRED from
// its return via `PageProps<typeof load>` (no restated interface).
const load = (c: Context<"/lab/gallery/secret">) => ({
  agent: c.get<string>("agent") ?? "an unknown agent",
});

const page: PageDef<"/lab/gallery/secret", PageProps<typeof load>> = {
  load,

  component: ({ agent }: PageProps<typeof load>): ReactNode => (
    <article data-file-route="gallery-secret">
      <h2 className="section-title">The pocket listing</h2>

      <p className="copy">
        You reached this page only because the co-located <code>middleware.ts</code>{" "}
        let you through (the <code>?key=jade</code> pass). Without it, the guard{" "}
        redirected you to the gallery <em>before</em> this page&apos;s loader ever ran.
      </p>

      <p className="copy">
        And the guard augmented the loader&apos;s context: it set the listing agent,
        which <code>load</code> read with <code>c.get(&quot;agent&quot;)</code> →{" "}
        <strong data-secret-agent>{agent}</strong>.
      </p>

      <p className="copy">
        <Link href="/lab/gallery">← Back to the gallery</Link>
      </p>
    </article>
  ),

  metadata: () => ({
    title: "Pocket listing · Jade Mills Estates",
    description: "A file-routed page guarded by a co-located middleware.ts.",
  }),
};

export default page;
