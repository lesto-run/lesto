/**
 * The on-page table of contents — the right rail.
 *
 * Built straight from the heading outline `@lesto/content-markdown` extracted
 * while rendering the page, so it never re-parses the HTML. Each heading already
 * carries the `slug` that the renderer set as the element's `id`, so the links
 * are plain in-page anchors. We show H2s and H3s; H1 is the page title, and
 * deeper levels would crowd the rail. The rail is hidden below 1024px (the
 * `max-[1024px]:hidden` utility), so it renders nothing rather than empty chrome
 * when there is nothing worth linking to. Links stay muted and only warm to the
 * foreground on hover — the rail is a quiet map, not a competing nav.
 */

import type { ReactElement } from "react";

import type { DocHeading } from "../content";

const TOC_LINK =
  "block py-[0.28rem] leading-snug text-muted no-underline transition-colors hover:text-fg hover:no-underline";

export function TableOfContents({
  headings,
}: {
  headings: readonly DocHeading[];
}): ReactElement | null {
  const shown = headings.filter((h) => h.depth === 2 || h.depth === 3);
  if (shown.length === 0) return null;

  return (
    <nav
      className="sticky top-[80px] max-h-[calc(100vh-96px)] self-start overflow-y-auto text-[0.8rem] max-[1024px]:hidden"
      aria-label="On this page"
    >
      <p className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
        On this page
      </p>
      <ul className="m-0 list-none p-0">
        {shown.map((h) => (
          <li key={h.slug} className={h.depth === 3 ? "pl-3" : undefined}>
            <a className={TOC_LINK} href={`#${h.slug}`}>
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
