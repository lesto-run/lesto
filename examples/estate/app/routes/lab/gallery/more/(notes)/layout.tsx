/**
 * A ROUTE-GROUP layout — lives at `more/(notes)/layout.tsx` (ADR 0023, dx-parity W6).
 *
 * `(notes)` is a PATHLESS group: it adds NO URL segment (its `about` child is
 * `/lab/gallery/more/about`, not `/lab/gallery/more/notes/about`), yet its
 * `layout.tsx` still wraps every page in the group — nesting by directory like any
 * other layout. So a group organizes files and shares chrome without shaping the URL.
 */

import type { ReactNode } from "react";

/** Frame the group's pages so the pathless `(notes)` folder is visible in the chrome. */
export default function NotesLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <section data-file-route-layout="notes-group" className="card">
      <p className="copy">
        Wrapped by the <code>(notes)</code> group&apos;s <code>layout.tsx</code> — a
        pathless folder, so this adds chrome but no URL segment.
      </p>

      {children}
    </section>
  );
}
