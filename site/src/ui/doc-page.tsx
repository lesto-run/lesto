/**
 * The frame around one rendered doc: sidebar · article · table of contents.
 *
 * The chrome (sidebar nav, breadcrumbs, page actions, prev/next) is Tailwind
 * utilities compiled by `@lesto/styles`; the article body keeps the `.docs-article`
 * class (custom CSS in `app/styles/app.css`), since it styles the HTML
 * `@lesto/content-markdown` rendered + sanitized at build time and injected
 * directly. The sidebar is the whole-site nav with the current page highlighted;
 * the right rail is this page's heading outline.
 *
 * `makeDocPage` closes a doc and the nav into a zero-prop component so the app
 * factory can register one static `.page()` per doc without a loader.
 */

import type { ReactElement } from "react";

import { markdownPath } from "../ai-docs";
import { adjacentDocs, type DocEntry, type NavSection } from "../content";
import { SITE_URL } from "../site";
import { TableOfContents } from "./toc";

const SIDEBAR_LINK =
  "block px-[0.6rem] py-[0.3rem] rounded-md text-[0.92rem] no-underline hover:bg-surface hover:no-underline";

function Sidebar({ nav, current }: { nav: readonly NavSection[]; current: string }): ReactElement {
  return (
    <aside className="sticky top-[72px] self-start max-h-[calc(100vh-88px)] overflow-y-auto max-[720px]:static max-[720px]:max-h-none max-[720px]:border-b max-[720px]:border-border max-[720px]:pb-4">
      {nav.map((section) => (
        <div className="mb-6" key={section.title}>
          <p className="text-[0.72rem] font-bold uppercase tracking-[0.06em] text-muted mb-2">
            {section.title}
          </p>
          <ul className="list-none m-0 p-0">
            {section.items.map((item) => (
              <li key={item.route}>
                <a
                  href={item.route}
                  className={
                    item.route === current
                      ? `${SIDEBAR_LINK} bg-accent text-accent-fg font-semibold`
                      : `${SIDEBAR_LINK} text-fg`
                  }
                >
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
    <nav className="text-[0.82rem] text-muted [&_a]:text-muted" aria-label="Breadcrumb">
      <a href="/">Docs</a>
      <span aria-hidden="true"> / </span>
      <span>{doc.section}</span>
      <span aria-hidden="true"> / </span>
      <span className="text-fg">{doc.title}</span>
    </nav>
  );
}

/**
 * Agent-native page actions: read this page as clean Markdown (its `.md` twin), or
 * open it in an assistant. The `.md` URL is known at build time, so the links are
 * static — no client JS. "Copy as Markdown" is a `data-copy-md` button the
 * copy-code island wires up on the client.
 */
function PageActions({ doc }: { doc: DocEntry }): ReactElement {
  // Relative path for the same-origin runtime fetch + the in-page link; absolute
  // canonical URL only for the assistant prompt an external tool resolves.
  const mdPath = `/${markdownPath(doc.route)}`;
  const chatPrompt = `Read ${SITE_URL}${mdPath} and help me with it.`;
  const action =
    "text-[0.78rem] text-muted bg-surface border border-border rounded-md px-[0.55rem] py-1 cursor-pointer no-underline hover:text-fg hover:border-accent hover:no-underline";
  return (
    <div className="flex items-center gap-[0.4rem]">
      <a className={action} href={mdPath}>
        View as Markdown
      </a>
      <button type="button" className={`docs-action-copy ${action}`} data-copy-md={mdPath}>
        Copy as Markdown
      </button>
      <a
        className={action}
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
function PrevNext({
  nav,
  current,
}: {
  nav: readonly NavSection[];
  current: string;
}): ReactElement | null {
  const { prev, next } = adjacentDocs(nav, current);
  if (prev === undefined && next === undefined) return null;
  const link =
    "flex flex-col gap-[0.2rem] px-4 py-3 border border-border rounded-[10px] max-w-[48%] no-underline hover:border-accent hover:no-underline";
  return (
    <nav
      className="flex justify-between gap-4 mt-12 pt-6 border-t border-border"
      aria-label="Pagination"
    >
      {prev === undefined ? (
        <span />
      ) : (
        <a href={prev.route} className={link}>
          <span className="text-[0.78rem] text-muted">← Previous</span>
          <span className="font-semibold text-fg">{prev.title}</span>
        </a>
      )}
      {next === undefined ? (
        <span />
      ) : (
        <a href={next.route} className={`${link} text-right ml-auto`}>
          <span className="text-[0.78rem] text-muted">Next →</span>
          <span className="font-semibold text-fg">{next.title}</span>
        </a>
      )}
    </nav>
  );
}

export function DocPage({ doc, nav }: { doc: DocEntry; nav: readonly NavSection[] }): ReactElement {
  return (
    <div className="grid grid-cols-[248px_minmax(0,1fr)_200px] gap-10 max-w-[1240px] mx-auto pt-8 px-5 pb-16 max-[1024px]:grid-cols-[248px_minmax(0,1fr)] max-[720px]:grid-cols-[minmax(0,1fr)] max-[720px]:gap-6">
      <Sidebar nav={nav} current={doc.route} />
      <main className="min-w-0">
        <div className="flex items-center justify-between gap-4 flex-wrap mb-5">
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
