/**
 * The site layout — the `.layout()` every marketing page nests inside. It owns
 * the chrome that is identical on every page: the inline stylesheet, the sticky
 * header, and the footer. A `.layout()` only ever receives `children`.
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
            <a href={DOCS_URL} data-analytics="nav_docs">
              Docs
            </a>
            <a href="/use-cases" className="hide-sm" data-analytics="nav_use_cases">
              Use cases
            </a>
            <a href="/blog" className="hide-sm" data-analytics="nav_blog">
              Blog
            </a>
            <a href={GITHUB_URL} className="nav-cta" data-analytics="nav_github">
              GitHub ↗
            </a>
          </nav>
        </div>
      </header>
      {children}
      <footer className="site-footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <Brand />
            <p>Batteries-included, agent-native, full-stack TypeScript. Built on one database.</p>
          </div>
          <div className="fcol">
            <strong>Product</strong>
            <a href="/use-cases">Use cases</a>
            <a href="/blog">Blog</a>
            <a href="/changelog">Changelog</a>
          </div>
          <div className="fcol">
            <strong>Docs</strong>
            <a href={`${DOCS_URL}/quickstart`}>Quickstart</a>
            <a href={`${DOCS_URL}/concepts`}>Concepts</a>
            <a href={`${DOCS_URL}/why-lesto`}>Why Lesto</a>
            <a href={`${DOCS_URL}/deploy/cloudflare`}>Deploy</a>
          </div>
          <div className="fcol">
            <strong>Project</strong>
            <a href={GITHUB_URL}>GitHub</a>
            <a href="https://www.npmjs.com/package/@lesto/web">npm</a>
            <a href={`${GITHUB_URL}/blob/main/LICENSE`}>License (MIT)</a>
            <a href={`${GITHUB_URL}/blob/main/CONTRIBUTING.md`}>Contributing</a>
          </div>
        </div>
        <div className="footer-base">
          <span>Built with Lesto — a static, prerendered Lesto app.</span>
          <span>Batteries-included. Agent-native.</span>
        </div>
      </footer>
      {/* Headless islands: boot client behavior, render nothing visible. */}
      <AnalyticsIsland />
      <PackageTabsIsland />
    </>
  );
}
