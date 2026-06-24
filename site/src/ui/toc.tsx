/**
 * The on-page table of contents — the right rail.
 *
 * Built straight from the heading outline `@lesto/content-markdown` extracted
 * while rendering the page, so it never re-parses the HTML. Each heading already
 * carries the `slug` that the renderer set as the element's `id`, so the links
 * are plain in-page anchors. We show H2s and H3s; H1 is the page title, and
 * deeper levels would crowd the rail. The rail is hidden below 1024px (see the
 * stylesheet), so it renders nothing rather than empty chrome when there is
 * nothing worth linking to.
 */

import type { ReactElement } from "react";

import type { DocHeading } from "../content";

export function TableOfContents({
  headings,
}: {
  headings: readonly DocHeading[];
}): ReactElement | null {
  const shown = headings.filter((h) => h.depth === 2 || h.depth === 3);
  if (shown.length === 0) return null;

  return (
    <nav
      className="sticky top-[72px] self-start text-[0.85rem] max-[1024px]:hidden"
      aria-label="On this page"
    >
      <p className="text-[0.72rem] font-bold uppercase tracking-[0.06em] text-muted mb-2">
        On this page
      </p>
      <ul className="list-none m-0 p-0">
        {shown.map((h) => (
          <li key={h.slug} className={h.depth === 3 ? "pl-[0.85rem]" : undefined}>
            <a
              className="block py-[0.2rem] text-muted no-underline hover:text-fg hover:no-underline"
              href={`#${h.slug}`}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
