/**
 * The site layout — the `.layout()` every doc page nests inside.
 *
 * It owns the chrome that is identical on every page: the inline stylesheet
 * (emitted once at the top of `<body>`), the sticky header, and the footer. The
 * page-specific frame — the sidebar, the article, the table of contents — lives
 * in {@link "./doc-page".DocPage}, because that frame needs the page's own data
 * (its nav highlight and heading outline) and a `.layout()` only ever receives
 * `children`.
 */

import type { ReactElement, ReactNode } from "react";

import { DOCS_CSS } from "./styles";

export function DocsLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <>
      <style>{DOCS_CSS}</style>
      <header className="docs-header">
        <span className="brand">
          <a href="/">Lesto</a>
        </span>
        <span className="tag">docs</span>
        <span className="spacer" />
        <nav>
          <a href="/quickstart">Quickstart</a>
          <a href="https://github.com/lesto-run/lesto">GitHub</a>
        </nav>
      </header>
      {children}
      <footer className="docs-footer">
        Built with Lesto — these pages are Markdown rendered by{" "}
        <code>@lesto/content-*</code> and prerendered to static HTML.
      </footer>
    </>
  );
}
