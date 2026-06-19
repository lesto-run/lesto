/**
 * The frame around one rendered doc: sidebar · article · table of contents.
 *
 * The article body is the HTML `@lesto/content-markdown` produced — and
 * sanitized — at build time, injected directly so it renders under the same
 * React instance as the rest of the page. The sidebar is the whole-site nav with
 * the current page highlighted; the right rail is this page's heading outline.
 *
 * `makeDocPage` closes a doc and the nav into a zero-prop component so the app
 * factory can register one static `.page()` per doc without a loader — the page
 * is fully determined at build time.
 */

import type { ReactElement } from "react";

import type { DocEntry, NavSection } from "../content";
import { TableOfContents } from "./toc";

function Sidebar({ nav, current }: { nav: readonly NavSection[]; current: string }): ReactElement {
  return (
    <aside className="docs-sidebar">
      {nav.map((section) => (
        <div className="section" key={section.title}>
          <p className="section-title">{section.title}</p>
          <ul>
            {section.items.map((item) => (
              <li key={item.route}>
                <a href={item.route} className={item.route === current ? "active" : undefined}>
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </aside>
  );
}

export function DocPage({ doc, nav }: { doc: DocEntry; nav: readonly NavSection[] }): ReactElement {
  return (
    <div className="docs-shell">
      <Sidebar nav={nav} current={doc.route} />
      <main className="docs-main">
        {/* doc.html is sanitized by the content-markdown render pass at build time. */}
        <article className="docs-article" dangerouslySetInnerHTML={{ __html: doc.html }} />
      </main>
      <TableOfContents headings={doc.headings} />
    </div>
  );
}

/** Bind a doc + nav into a zero-prop page component for static route registration. */
export function makeDocPage(doc: DocEntry, nav: readonly NavSection[]): () => ReactElement {
  return function BoundDocPage(): ReactElement {
    return <DocPage doc={doc} nav={nav} />;
  };
}
