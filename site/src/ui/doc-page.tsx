/**
 * The frame around one rendered doc: sidebar · article · table of contents.
 *
 * The chrome (sidebar nav, breadcrumbs, page actions, prev/next) is Tailwind
 * utilities compiled by `@lesto/styles`; the article body keeps the `.docs-article`
 * class (base CSS in `app/styles/app.css`, plus the shell's typographic pass in
 * the layout's inline styles), since it styles the HTML `@lesto/content-markdown`
 * rendered + sanitized at build time and injected directly. The sidebar is the
 * whole-site nav with the current page highlighted; the right rail is this page's
 * heading outline. The article column is capped near 70ch and centered in its
 * grid track — the measure does the readability work, the accent stays reserved
 * for links and the active nav item.
 *
 * `makeDocPage` closes a doc and the nav into a zero-prop component so the app
 * factory can register one static `.page()` per doc without a loader.
 */

import { markdownTwinPath } from "@lesto/content-core";
import type { ReactElement } from "react";

import { adjacentDocs, type DocEntry, type NavSection } from "../content";
import { SITE_URL } from "../site";
import { TableOfContents } from "./toc";

const SIDEBAR_LINK =
  "block rounded-md px-2 py-[0.32rem] text-[0.875rem] leading-snug no-underline transition-colors hover:no-underline";

/**
 * Center the active sidebar link inside the sidebar's own scroll box on load.
 *
 * The docs are a multi-page app — every navigation is a full document load, which
 * resets the sidebar's scroll to the top and can leave the current page off-screen.
 * This runs as a plain inline script placed right after the `<aside>`: at that point
 * the nav is fully parsed, so it can set `scrollTop` synchronously *before first
 * paint* — the active item is already in view, with no post-hydration jump. It only
 * moves the sidebar's internal scroll (never the window), and no-ops on mobile where
 * the aside isn't a scroll container.
 */
const SIDEBAR_SCROLL_SCRIPT =
  "(function(){var s=document.getElementById('docs-sidebar');if(!s)return;" +
  "var a=s.querySelector('[aria-current=\"page\"]');if(!a)return;" +
  "var t=a.offsetTop-(s.clientHeight-a.offsetHeight)/2;s.scrollTop=t>0?t:0;})();";

function Sidebar({ nav, current }: { nav: readonly NavSection[]; current: string }): ReactElement {
  return (
    <>
      <aside
        id="docs-sidebar"
        className="sticky top-[72px] self-start max-h-[calc(100vh-88px)] overflow-y-auto max-[720px]:static max-[720px]:max-h-none max-[720px]:overflow-visible max-[720px]:border-b max-[720px]:border-border max-[720px]:pb-4"
      >
        {nav.map((section) => (
          <div className="mb-7" key={section.title}>
            <p className="mb-2 px-2 text-[0.78rem] font-semibold text-fg/90">{section.title}</p>
            <ul className="m-0 flex list-none flex-col gap-[1px] p-0">
              {section.items.map((item) => (
                <li key={item.route}>
                  <a
                    href={item.route}
                    aria-current={item.route === current ? "page" : undefined}
                    className={
                      item.route === current
                        ? `${SIDEBAR_LINK} bg-surface font-semibold text-fg`
                        : `${SIDEBAR_LINK} text-muted hover:bg-surface hover:text-fg`
                    }
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>
      {/* eslint-disable-next-line react/no-danger — a static, self-authored pre-paint
          script (no user input); must run inline to avoid a scroll flash. */}
      <script dangerouslySetInnerHTML={{ __html: SIDEBAR_SCROLL_SCRIPT }} />
    </>
  );
}

/**
 * The Polar-style page header rendered from frontmatter — an eyebrow (the section),
 * the large title, and the description as a lead. The content pipeline strips the
 * body's leading `# H1`, so this is the page's only (and semantic) `<h1>`.
 */
function PageHeader({ doc }: { doc: DocEntry }): ReactElement {
  return (
    <header className="mb-9">
      <p className="mb-2.5 text-[0.8rem] font-medium text-muted">{doc.section}</p>
      <h1 className="m-0 text-[2.5rem] font-bold leading-[1.1] tracking-[-0.03em] text-fg max-[720px]:text-[2rem]">
        {doc.title}
      </h1>
      {doc.description !== undefined && doc.description !== "" ? (
        <p className="mt-3.5 text-[1.075rem] leading-relaxed text-muted">{doc.description}</p>
      ) : null}
    </header>
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
  const mdPath = `/${markdownTwinPath(doc.route)}`;
  const chatPrompt = `Read ${SITE_URL}${mdPath} and help me with it.`;
  const action =
    "cursor-pointer rounded-lg border border-border px-2.5 py-1 text-[0.75rem] font-medium text-muted no-underline transition-colors hover:bg-surface hover:text-fg hover:no-underline";
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
    "group flex max-w-[48%] flex-col gap-1 rounded-xl border border-border px-5 py-4 no-underline transition-colors hover:border-fg/25 hover:bg-surface hover:no-underline";
  const title = "font-medium text-fg";
  return (
    <nav className="mt-16 flex justify-between gap-4" aria-label="Pagination">
      {prev === undefined ? (
        <span />
      ) : (
        <a href={prev.route} className={link}>
          <span className="text-[0.75rem] font-medium text-muted">← Previous</span>
          <span className={title}>{prev.title}</span>
        </a>
      )}
      {next === undefined ? (
        <span />
      ) : (
        <a href={next.route} className={`${link} ml-auto items-end text-right`}>
          <span className="text-[0.75rem] font-medium text-muted">Next →</span>
          <span className={title}>{next.title}</span>
        </a>
      )}
    </nav>
  );
}

export function DocPage({ doc, nav }: { doc: DocEntry; nav: readonly NavSection[] }): ReactElement {
  return (
    <div className="mx-auto grid max-w-[1376px] grid-cols-[256px_minmax(0,1fr)_224px] gap-10 px-6 pt-9 pb-20 max-[1024px]:grid-cols-[256px_minmax(0,1fr)] max-[720px]:grid-cols-[minmax(0,1fr)] max-[720px]:gap-6 max-[720px]:pt-6">
      <Sidebar nav={nav} current={doc.route} />
      <main className="min-w-0">
        {/* The reading column: capped near 70ch, centered in its grid track. */}
        <div className="mx-auto w-full max-w-[44rem]">
          <div className="mb-5 flex justify-end">
            <PageActions doc={doc} />
          </div>
          <PageHeader doc={doc} />
          {/* doc.html is sanitized by the content-markdown render pass at build time. */}
          <article className="docs-article" dangerouslySetInnerHTML={{ __html: doc.html }} />
          <PrevNext nav={nav} current={doc.route} />
        </div>
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
