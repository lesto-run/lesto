/**
 * The site layout — the `.layout()` every marketing page nests inside. It owns the
 * chrome identical on every page: the sticky header and the footer. Styling is
 * Tailwind utilities compiled by `@lesto/styles` (the design system + irreducible
 * custom CSS live in `app/styles/app.css`, linked via `.styles()`); the only inline
 * `<style>` left is `@lesto/content-markdown`'s component CSS (callouts + package
 * tabs), which is a dependency's styles, not this site's design. A `.layout()` only
 * ever receives `children`.
 */

import type { ReactElement, ReactNode } from "react";

import { calloutStyles, packageCommandStyles } from "@lesto/content-markdown/styles";

import AnalyticsIsland from "../../app/islands/analytics";
import PackageTabsIsland from "../../app/islands/package-tabs";
import { DOCS_URL, GITHUB_URL } from "../site";

/** The brand lockup — the indigo "L" mark and the wordmark, linking home. */
export function Brand(): ReactElement {
  return (
    <a
      className="inline-flex items-center gap-[0.55rem] text-[1.02rem] font-[640] tracking-[-0.02em] text-ink"
      href="/"
    >
      <span className="inline-grid place-items-center w-[23px] h-[23px] rounded-md bg-accent text-white font-bold text-[0.82rem] shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]">
        L
      </span>{" "}
      Lesto
    </a>
  );
}

/** A footer link column. */
function FooterCol({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col gap-[0.55rem] [&_a]:text-ink-2 [&_a]:text-[0.89rem] [&_a]:tracking-[-0.01em] [&_a:hover]:text-accent">
      <strong className="text-[0.74rem] uppercase tracking-[0.07em] text-faint font-semibold mb-[0.15rem]">
        {title}
      </strong>
      {children}
    </div>
  );
}

export function SiteLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <>
      {/* A dependency's component CSS (rendered-Markdown callouts + package-manager
          tabs) — not this site's design, so it stays injected rather than folded into
          the Tailwind entry @lesto/styles compiles. */}
      <style>{calloutStyles + packageCommandStyles}</style>
      <header className="sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--bg)_78%,transparent)] backdrop-blur-[14px] backdrop-saturate-[1.8]">
        <div className="flex items-center gap-4 h-[60px] max-w-[1080px] mx-auto px-7">
          <Brand />
          <span className="flex-1" />
          <nav className="flex items-center gap-[1.6rem] [&>a]:text-[0.9rem] [&>a]:tracking-[-0.01em]">
            <a
              className="text-muted font-[480] hover:text-ink"
              href={DOCS_URL}
              data-analytics="nav_docs"
            >
              Docs
            </a>
            <a
              className="text-muted font-[480] hover:text-ink max-sm:hidden"
              href="/use-cases"
              data-analytics="nav_use_cases"
            >
              Use cases
            </a>
            <a
              className="text-muted font-[480] hover:text-ink max-sm:hidden"
              href="/blog"
              data-analytics="nav_blog"
            >
              Blog
            </a>
            <a
              className="text-ink font-[540] hover:text-accent"
              href={GITHUB_URL}
              data-analytics="nav_github"
            >
              GitHub ↗
            </a>
          </nav>
        </div>
      </header>
      {children}
      <footer className="border-t border-line">
        <div className="max-w-[1080px] mx-auto px-7 pt-14 pb-8 grid grid-cols-[1.6fr_1fr_1fr_1fr] gap-8 max-[720px]:grid-cols-2 max-[720px]:gap-7">
          <div className="flex flex-col items-start gap-[0.7rem]">
            <Brand />
            <p className="m-0 text-muted text-[0.86rem] leading-normal max-w-[17rem] tracking-[-0.01em]">
              Batteries-included, agent-native, full-stack TypeScript. Built on one database.
            </p>
          </div>
          <FooterCol title="Product">
            <a href="/use-cases">Use cases</a>
            <a href="/blog">Blog</a>
            <a href="/changelog">Changelog</a>
          </FooterCol>
          <FooterCol title="Docs">
            <a href={`${DOCS_URL}/quickstart`}>Quickstart</a>
            <a href={`${DOCS_URL}/concepts`}>Concepts</a>
            <a href={`${DOCS_URL}/why-lesto`}>Why Lesto</a>
            <a href={`${DOCS_URL}/deploy/cloudflare`}>Deploy</a>
          </FooterCol>
          <FooterCol title="Project">
            <a href={GITHUB_URL}>GitHub</a>
            <a href="https://www.npmjs.com/package/@lesto/web">npm</a>
            <a href={`${GITHUB_URL}/blob/main/LICENSE`}>License (MIT)</a>
            <a href={`${GITHUB_URL}/blob/main/CONTRIBUTING.md`}>Contributing</a>
          </FooterCol>
        </div>
        <div className="max-w-[1080px] mx-auto px-7 pt-[1.4rem] pb-10 border-t border-line text-faint text-[0.82rem] flex justify-between flex-wrap gap-2">
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
