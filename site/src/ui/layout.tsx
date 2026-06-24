/**
 * The site layout — the `.layout()` every doc page nests inside.
 *
 * It owns the chrome identical on every page: the sticky header and the footer.
 * Styling is Tailwind utilities compiled by `@lesto/styles` (design system +
 * irreducible custom CSS in `app/styles/app.css`, linked via `.styles()`); the only
 * inline `<style>` left is dependency component CSS — the ⌘K command palette
 * (`@lesto/content-search`) and the callout / package-tab styles
 * (`@lesto/content-markdown`) — which is the framework's look, not the docs' design.
 *
 * The page-specific frame — sidebar, article, TOC — lives in {@link "./doc-page".DocPage},
 * since it needs the page's own data and a `.layout()` only receives `children`.
 */

import type { ReactElement, ReactNode } from "react";

import { commandPaletteStyles } from "@lesto/content-search";
import { calloutStyles, packageCommandStyles } from "@lesto/content-markdown/styles";

import AnalyticsIsland from "../../app/islands/analytics";
import CopyCodeIsland from "../../app/islands/copy-code";
import PackageTabsIsland from "../../app/islands/package-tabs";
import SearchIsland from "../../app/islands/search";

export function DocsLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <>
      {/* Dependency component CSS (the ⌘K palette + rendered-Markdown callouts +
          package tabs) — the framework's own look, kept injected rather than folded
          into the Tailwind entry @lesto/styles compiles. */}
      <style>{commandPaletteStyles + calloutStyles + packageCommandStyles}</style>
      {/* `docs-header` stays a class purely for its frosted ::before backdrop (a
          backdrop-filter on the header itself would clip the ⌘K overlay). */}
      <header className="docs-header sticky top-0 z-10 flex items-center gap-3 h-[56px] px-5 border-b border-border">
        <span className="font-bold text-[1.05rem] tracking-[-0.01em]">
          <a className="text-fg" href="/">
            Lesto
          </a>
        </span>
        <span className="text-muted text-[0.85rem]">docs</span>
        <span className="flex-1" />
        <SearchIsland />
        <nav className="[&>a]:text-muted [&>a]:text-[0.9rem] [&>a]:ml-4">
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
      <footer className="max-w-[1240px] mx-auto pt-6 px-5 pb-12 text-muted text-[0.85rem] border-t border-border">
        Built with Lesto — these pages are Markdown rendered by{" "}
        <code className="font-mono">@lesto/content-*</code> and prerendered to static HTML.
      </footer>
      {/* Headless islands: boot client behavior, render nothing visible. */}
      <AnalyticsIsland />
      <CopyCodeIsland />
      <PackageTabsIsland />
    </>
  );
}
