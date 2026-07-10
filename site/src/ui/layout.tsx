/**
 * The site layout — the `.layout()` every doc page nests inside.
 *
 * It owns the chrome identical on every page: the sticky header and the footer.
 * Styling is Tailwind utilities compiled by `@lesto/styles` (design system +
 * irreducible custom CSS in `app/styles/app.css`, linked via `.styles()`). The
 * inline `<style>` carries dependency component CSS — the ⌘K command palette
 * (`@lesto/content-search`) and the callout / package-tab styles
 * (`@lesto/content-markdown`), the framework's look rather than the docs' design —
 * plus {@link docsArticleStyles}, the shell's typographic pass over the
 * build-time-rendered Markdown (utilities cannot reach generated children, and
 * these same-specificity overrides must follow the compiled stylesheet in
 * document order to win the cascade).
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

/**
 * The shell's typographic refinements over `.docs-article` — the Polar-style
 * reading pass: a large tight H1 with a muted lead paragraph, roomy H2s opened
 * by a hairline top border, quietly underlined links, framed code blocks and
 * images, and headings that clear the sticky header when an anchor jumps to
 * them. Layered over the base article CSS in `app/styles/app.css` on purpose:
 * these rules share its specificity and override it by coming later in the
 * document, and no utility class can style HTML `@lesto/content-markdown`
 * rendered at build time.
 */
const docsArticleStyles = `
.docs-article h1 { font-size: 2.35rem; font-weight: 700; letter-spacing: -0.025em; line-height: 1.15; margin: 0 0 0.85rem; }
.docs-article h1 + p { font-size: 1.08rem; color: var(--muted); margin: 0 0 1.75rem; }
.docs-article h2 { font-size: 1.4rem; font-weight: 600; letter-spacing: -0.015em; margin: 3rem 0 1rem; padding-top: 1.5rem; border-top: 1px solid var(--border); }
.docs-article h3 { font-size: 1.12rem; font-weight: 600; margin: 2rem 0 0.6rem; }
.docs-article h2, .docs-article h3, .docs-article h4 { scroll-margin-top: 5.5rem; }
.docs-article a { text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent) 30%, transparent); text-underline-offset: 3px; }
.docs-article a:hover { text-decoration-color: var(--accent); }
.docs-article li { margin: 0.3rem 0; }
.docs-article li::marker { color: var(--muted); }
.docs-article hr { border: none; border-top: 1px solid var(--border); margin: 2.75rem 0; }
.docs-article img { border-radius: 10px; border: 1px solid var(--border); }
.docs-article pre { border: 1px solid var(--border); border-radius: 12px; }
.docs-article [data-rehype-pretty-code-figure] { margin: 1.5rem 0; }
.docs-article [data-rehype-pretty-code-title] { border-radius: 12px 12px 0 0; color: #9aa4b2; }
.docs-article [data-rehype-pretty-code-title] + pre { border-radius: 0 0 12px 12px; border-top: none; }
.docs-article .lesto-pm-panel pre { border: none; }
`;

const NAV_LINKS =
  "flex items-center gap-5 [&>a]:text-[0.85rem] [&>a]:font-medium [&>a]:text-muted [&>a]:no-underline [&>a]:transition-colors [&>a:hover]:text-fg [&>a:hover]:no-underline";

export function DocsLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <>
      {/* Dependency component CSS (the ⌘K palette + rendered-Markdown callouts +
          package tabs) and the shell's article typography — kept injected rather
          than folded into the Tailwind entry @lesto/styles compiles. */}
      <style>
        {commandPaletteStyles + calloutStyles + packageCommandStyles + docsArticleStyles}
      </style>
      {/* `docs-header` stays a class purely for its frosted ::before backdrop (a
          backdrop-filter on the header itself would clip the ⌘K overlay). */}
      <header className="docs-header sticky top-0 z-10 border-b border-border">
        <div className="mx-auto flex h-16 max-w-[1376px] items-center gap-4 px-6">
          <a className="flex items-baseline gap-2 text-fg no-underline hover:no-underline" href="/">
            <span className="text-[1.02rem] font-bold tracking-[-0.02em]">Lesto</span>
            <span className="rounded-full border border-border px-2 py-[0.1rem] text-[0.72rem] font-medium text-muted">
              Docs
            </span>
          </a>
          <span className="flex-1" />
          <SearchIsland />
          <nav className={NAV_LINKS}>
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
        </div>
      </header>
      {children}
      <footer className="border-t border-border">
        <div className="mx-auto max-w-[1376px] px-6 py-10 text-[0.8rem] text-muted">
          Built with Lesto — these pages are Markdown rendered by{" "}
          <code className="font-mono">@lesto/content-*</code> and prerendered to static HTML.
        </div>
      </footer>
      {/* Headless islands: boot client behavior, render nothing visible. */}
      <AnalyticsIsland />
      <CopyCodeIsland />
      <PackageTabsIsland />
    </>
  );
}
