/**
 * The frame around one rendered doc: sidebar · article · table of contents.
 *
 * The article body is the HTML `@lesto/content-markdown` produced — and
 * sanitized — at build time, injected directly so it renders under the same
 * React instance as the rest of the page. The sidebar is the whole-site nav with
 * the current page highlighted; the right rail is this page's heading outline.
 * Above the article sit breadcrumbs and the page actions; below it, prev/next
 * navigation through the docs in reading order.
 *
 * `makeDocPage` closes a doc and the nav into a zero-prop component so the app
 * factory can register one static `.page()` per doc without a loader — the page
 * is fully determined at build time.
 */

import type { ReactElement } from "react";

import { markdownPath } from "../ai-docs";
import { adjacentDocs, type DocEntry, type NavSection } from "../content";
import { SITE_URL } from "../site";
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

/** Breadcrumbs: the section this page sits in, then the page title. */
function Breadcrumbs({ doc }: { doc: DocEntry }): ReactElement {
  return (
    <nav className="docs-crumbs" aria-label="Breadcrumb">
      <a href="/">Docs</a>
      <span aria-hidden="true"> / </span>
      <span>{doc.section}</span>
      <span aria-hidden="true"> / </span>
      <span className="current">{doc.title}</span>
    </nav>
  );
}

/**
 * Agent-native page actions: read this page as clean Markdown (its `.md` twin),
 * or open it in an assistant. The `.md` URL is known at build time, so the links
 * are static — no client JS. "Copy as Markdown" is a `data-copy-md` button the
 * copy-code island wires up on the client.
 */
function PageActions({ doc }: { doc: DocEntry }): ReactElement {
  // Relative path for the same-origin runtime fetch + the in-page link (works on
  // any host the site is served from); absolute canonical URL only for the
  // assistant prompt, which an external tool resolves against the real home.
  const mdPath = `/${markdownPath(doc.route)}`;
  const chatPrompt = `Read ${SITE_URL}${mdPath} and help me with it.`;
  return (
    <div className="docs-actions">
      <a href={mdPath}>View as Markdown</a>
      <button type="button" className="docs-action-copy" data-copy-md={mdPath}>
        Copy as Markdown
      </button>
      <a
        href={`https://chatgpt.com/?q=${encodeURIComponent(chatPrompt)}`}
        target="_blank"
        rel="noreferrer"
        data-analytics="open_in_chatgpt"
      >
        Open in ChatGPT
      </a>
    </div>
  );
}

/** Prev/next navigation through the docs in reading order. */
function PrevNext({ nav, current }: { nav: readonly NavSection[]; current: string }): ReactElement | null {
  const { prev, next } = adjacentDocs(nav, current);
  if (prev === undefined && next === undefined) return null;
  return (
    <nav className="docs-prevnext" aria-label="Pagination">
      {prev === undefined ? (
        <span />
      ) : (
        <a href={prev.route} className="prev">
          <span className="dir">← Previous</span>
          <span className="label">{prev.title}</span>
        </a>
      )}
      {next === undefined ? (
        <span />
      ) : (
        <a href={next.route} className="next">
          <span className="dir">Next →</span>
          <span className="label">{next.title}</span>
        </a>
      )}
    </nav>
  );
}

export function DocPage({ doc, nav }: { doc: DocEntry; nav: readonly NavSection[] }): ReactElement {
  return (
    <div className="docs-shell">
      <Sidebar nav={nav} current={doc.route} />
      <main className="docs-main">
        <div className="docs-topbar">
          <Breadcrumbs doc={doc} />
          <PageActions doc={doc} />
        </div>
        {/* doc.html is sanitized by the content-markdown render pass at build time. */}
        <article className="docs-article" dangerouslySetInnerHTML={{ __html: doc.html }} />
        <PrevNext nav={nav} current={doc.route} />
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
