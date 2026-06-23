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

import AnalyticsIsland from "../../app/islands/analytics";
import CopyCodeIsland from "../../app/islands/copy-code";
import PackageTabsIsland from "../../app/islands/package-tabs";
import SearchIsland from "../../app/islands/search";
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
        <SearchIsland />
        <nav>
          <a href="/quickstart" data-analytics="nav_quickstart">
            Quickstart
          </a>
          {/* The blog + changelog live on the marketing site (lesto.run). */}
          <a href="https://lesto.run/blog" data-analytics="nav_blog">
            Blog
          </a>
          <a href="https://lesto.run/changelog" data-analytics="nav_changelog">
            Changelog
          </a>
          <a href="https://github.com/lesto-run/lesto" data-analytics="nav_github">
            GitHub
          </a>
        </nav>
      </header>
      {children}
      <footer className="docs-footer">
        Built with Lesto — these pages are Markdown rendered by{" "}
        <code>@lesto/content-*</code> and prerendered to static HTML.
      </footer>
      {/* Headless islands: boot client behavior, render nothing visible. */}
      <AnalyticsIsland />
      <CopyCodeIsland />
      <PackageTabsIsland />
    </>
  );
}
