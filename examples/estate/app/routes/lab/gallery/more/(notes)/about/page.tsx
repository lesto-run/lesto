/**
 * A page INSIDE a route group — lives at `more/(notes)/about/page.tsx`, so it
 * registers at `/lab/gallery/more/about` (the `(notes)` group adds no URL segment;
 * ADR 0023, dx-parity W6). It is wrapped by the group's `layout.tsx`.
 */

import type { ReactNode } from "react";

import { Link } from "@lesto/ui";
import type { PageDef } from "@lesto/web";

const page: PageDef<"/lab/gallery/more/about"> = {
  component: (): ReactNode => (
    <div data-file-route="more-group-about">
      <h2 className="section-title">About these segments</h2>

      <p className="copy">
        This page&apos;s file is under <code>(notes)/</code>, but its URL is{" "}
        <code>/lab/gallery/more/about</code> — the group folder vanished from the path
        while still nesting the layout above.
      </p>

      <p className="copy">
        <Link href="/lab/gallery/more">← Back to richer segments</Link>
      </p>
    </div>
  ),

  metadata: () => ({
    title: "About · Richer segments",
    description: "A page filed inside a pathless (notes) route group.",
  }),
};

export default page;
