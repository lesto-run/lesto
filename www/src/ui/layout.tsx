/**
 * The site layout — the `.layout()` every marketing page nests inside.
 *
 * It owns the chrome that is identical on every page: the inline stylesheet
 * (emitted once at the top of `<body>`), the sticky header, and the footer. A
 * `.layout()` only ever receives `children`, so anything that needs the page's
 * own data lives in the page component; the header and footer need none.
 *
 * The header is a solid, sticky bar above each page (including the gradient hero
 * on `/`), so the same chrome reads correctly on the landing page and on the
 * editorial pages (blog, changelog, use-cases) without per-page state.
 */

import type { ReactElement, ReactNode } from "react";

import AnalyticsIsland from "../../app/islands/analytics";
import PackageTabsIsland from "../../app/islands/package-tabs";
import { DOCS_URL, GITHUB_URL } from "../site";
import { SITE_CSS } from "./styles";

/** The brand lockup — the indigo "L" mark and the wordmark, linking home. */
export function Brand(): ReactElement {
  return (
    <a className="brand" href="/">
      <span className="brand-mark">L</span> Lesto
    </a>
  );
}

export function SiteLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <>
      <style>{SITE_CSS}</style>
      <header className="site-header">
        <div className="header-inner">
          <Brand />
          <span className="spacer" />
          <nav>
            <a href="/use-cases" className="hide-sm" data-analytics="nav_use_cases">
              Use cases
            </a>
            <a href="/blog" className="hide-sm" data-analytics="nav_blog">
              Blog
            </a>
            <a href={`${DOCS_URL}`} data-analytics="nav_docs">
              Docs
            </a>
            <a href={GITHUB_URL} className="hide-sm" data-analytics="nav_github">
              GitHub
            </a>
            <a href={`${DOCS_URL}/quickstart`} className="nav-cta" data-analytics="nav_get_started">
              Get started
            </a>
          </nav>
        </div>
      </header>
      {children}
      <footer className="site-footer">
        <div className="footer-inner">
          <div className="col">
            <strong>Lesto</strong>
            <a href="/">Home</a>
            <a href="/use-cases">Use cases</a>
            <a href="/blog">Blog</a>
            <a href="/changelog">Changelog</a>
          </div>
          <div className="col">
            <strong>Docs</strong>
            <a href={`${DOCS_URL}/quickstart`}>Quickstart</a>
            <a href={`${DOCS_URL}/concepts`}>Concepts</a>
            <a href={`${DOCS_URL}/why-lesto`}>Why Lesto</a>
            <a href={`${DOCS_URL}/deploy/cloudflare`}>Deploy</a>
          </div>
          <div className="col">
            <strong>Project</strong>
            <a href={GITHUB_URL}>GitHub</a>
            <a href={`${GITHUB_URL}/blob/main/LICENSE`}>License (MIT)</a>
            <a href={`${GITHUB_URL}/blob/main/CONTRIBUTING.md`}>Contributing</a>
          </div>
        </div>
        <p className="footer-note">
          Built with Lesto — this site is a static, prerendered Lesto app. Batteries-included,
          agent-native.
        </p>
      </footer>
      {/* Headless islands: boot client behavior, render nothing visible. */}
      <AnalyticsIsland />
      <PackageTabsIsland />
    </>
  );
}
