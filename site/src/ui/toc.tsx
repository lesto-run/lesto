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
  "block border-l border-transparent py-[0.28rem] leading-snug text-muted no-underline transition-colors hover:border-fg/40 hover:text-fg hover:no-underline";

export function TableOfContents({
  headings,
}: {
  headings: readonly DocHeading[];
}): ReactElement | null {
  const shown = headings.filter((h) => h.depth === 2 || h.depth === 3);
  if (shown.length === 0) return null;

  return (
    <nav
      className="sticky top-[72px] max-h-[calc(100vh-88px)] self-start overflow-y-auto text-[0.8rem] max-[1024px]:hidden"
      aria-label="On this page"
    >
      <p className="mb-3 text-[0.75rem] font-medium text-muted">On this page</p>
      {/* A quiet left rail; each link's own left border lights up on hover (and is
          the hook a future scroll-spy island flips to `border-fg` when active). */}
      <ul className="m-0 list-none border-l border-border p-0">
        {shown.map((h) => (
          <li key={h.slug}>
            <a className={`${TOC_LINK} ${h.depth === 3 ? "pl-6" : "pl-4"}`} href={`#${h.slug}`}>
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
