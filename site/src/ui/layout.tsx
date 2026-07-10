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
 * The shell's typographic delta over `.docs-article` — the refinements the base
 * article CSS (`app/styles/app.css`) can't express as plain rules: quietly
 * underlined near-white links, headings that clear the sticky header on an anchor
 * jump, and framed code blocks / images. Heading sizes and the h2 hairline live in
 * `app/styles/app.css`; the page title (h1) is rendered by the shell from
 * frontmatter, so nothing here styles a body h1. Layered after the compiled
 * stylesheet in document order so these same-specificity rules win, and because no
 * utility class can reach the HTML `@lesto/content-markdown` renders at build time.
 */
const docsArticleStyles = `
.docs-article h2, .docs-article h3, .docs-article h4 { scroll-margin-top: 5.5rem; }
.docs-article a { text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--fg) 26%, transparent); text-underline-offset: 3px; }
.docs-article a:hover { text-decoration-color: var(--fg); }
.docs-article li { margin: 0.3rem 0; }
.docs-article li::marker { color: var(--muted); }
.docs-article hr { border: none; border-top: 1px solid var(--border); margin: 2.75rem 0; }
.docs-article img { border-radius: 10px; border: 1px solid var(--border); }
.docs-article [data-rehype-pretty-code-figure] { margin: 1.5rem 0; }
.docs-article [data-rehype-pretty-code-title] + pre { border-top: none; }
.docs-article .lesto-pm-panel pre { border: none; }
`;

/** One header tab. Active shows a bright underline flush with the header's border. */
function HeaderTab({
  href,
  label,
  active,
  external,
  analytics,
}: {
  href: string;
  label: string;
  active?: boolean;
  external?: boolean;
  analytics?: string;
}): ReactElement {
  const base =
    "relative flex h-14 items-center text-[0.85rem] font-medium no-underline transition-colors hover:no-underline";
  const state = active
    ? "text-fg after:absolute after:inset-x-0 after:bottom-[-1px] after:h-[2px] after:bg-fg after:content-['']"
    : "text-muted hover:text-fg";
  return (
    <a
      href={href}
      className={`${base} ${state}`}
      data-analytics={analytics}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {label}
    </a>
  );
}

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
        <div className="mx-auto flex h-14 max-w-[1376px] items-center gap-7 px-6">
          <a className="flex items-baseline gap-2 text-fg no-underline hover:no-underline" href="/">
            <span className="text-[1.02rem] font-bold tracking-[-0.02em]">Lesto</span>
            <span className="rounded-full border border-border px-2 py-[0.1rem] text-[0.72rem] font-medium text-muted">
              Docs
            </span>
          </a>
          {/* Polar-style tab bar. The whole site is the Docs section, so Docs is
              always the active tab; the rest jump elsewhere. */}
          <nav className="flex items-center gap-6 max-[680px]:hidden" aria-label="Sections">
            <HeaderTab href="/" label="Docs" active />
            <HeaderTab href="/reference/cli" label="Reference" analytics="nav_reference" />
            <HeaderTab
              href="https://lesto.run/changelog"
              label="Changelog"
              external
              analytics="nav_changelog"
            />
            <HeaderTab
              href="https://github.com/lesto-run/lesto"
              label="GitHub"
              external
              analytics="nav_github"
            />
          </nav>
          <span className="flex-1" />
          <SearchIsland />
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
