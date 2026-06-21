/**
 * A CATCH-ALL page — registered at `/lab/gallery/more/path/*crumbs` because it
 * lives at `more/path/[...crumbs]/page.tsx` (ADR 0023, dx-parity W6).
 *
 * `[...crumbs]` compiles to the greedy `*crumbs`, which captures the WHOLE
 * remaining path (one or more segments) as a typed `string[]`. The `load` reads it
 * with the same `c.param(...)` a single `[id]` uses — but typed `string[]`, not
 * `string` (see `@lesto/router`'s `CatchAllParamKeys`). A bare `/lab/gallery/more/
 * path` does NOT match: a required catch-all needs at least one segment.
 */

import type { ReactNode } from "react";

import { Link } from "@lesto/ui";
import type { Context, PageDef, PageProps } from "@lesto/web";

// `c.param("crumbs")` is `string[]` here — the catch-all key's value type — so the
// component's props are INFERRED as `{ crumbs: string[] }` via `PageProps<typeof load>`.
const load = (c: Context<"/lab/gallery/more/path/*crumbs">) => ({ crumbs: c.param("crumbs") });

const page: PageDef<"/lab/gallery/more/path/*crumbs", PageProps<typeof load>> = {
  load,

  component: ({ crumbs }: PageProps<typeof load>): ReactNode => (
    <div data-file-route="more-catch-all">
      <h2 className="section-title">Catch-all trail</h2>

      <p className="copy">
        The path after <code>/path/</code> arrived as a{" "}
        <code data-crumb-count>{crumbs.length}</code>-element <code>string[]</code>:
      </p>

      <p className="copy" data-crumbs>
        {crumbs.join(" / ")}
      </p>

      <p className="copy">
        <Link href="/lab/gallery/more">← Back to richer segments</Link>
      </p>
    </div>
  ),

  metadata: ({ crumbs }: PageProps<typeof load>) => ({
    title: `${crumbs.join(" / ")} · Catch-all`,
    description: `A catch-all route that captured ${crumbs.length} path segments.`,
  }),
};

export default page;
