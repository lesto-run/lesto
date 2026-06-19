/**
 * The file-route convention's root layout (ADR 0023).
 *
 * Dropping a `layout.tsx` at the convention root wraps EVERY page discovered under
 * `app/routes/`. The applier (`applyFileRoutes`, `@lesto/web`) composes this around
 * each page's component automatically — no `.layout()` call, no per-page wiring.
 * It is an ordinary layout: a component handed the page (or a deeper layout) as
 * `children`. Here it frames the whole "gallery" demo so a visitor can see the file
 * tree's shape reflected in the chrome.
 */

import type { ReactNode } from "react";

import { Link } from "@lesto/ui";

/** Wrap every file-routed gallery page in a titled shell with a home link. */
export default function GalleryLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <section className="card" data-file-route-layout="root">
      <p className="copy">
        This whole section is <strong>file-routed</strong>: every page below was
        registered by dropping a file under <code>app/routes/</code> — no{" "}
        <code>.page()</code> call. This frame is the convention's root{" "}
        <code>layout.tsx</code>, wrapping them all.
      </p>

      {/* A <Link> back to the gallery index — soft-navigated when JS is on. */}
      <p className="copy">
        <Link href="/lab/gallery">← Back to the gallery</Link>
      </p>

      {children}
    </section>
  );
}
