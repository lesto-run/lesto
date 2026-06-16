/**
 * The estate's page layout — the `.layout()` every page nests inside.
 *
 * It carries the design-system stylesheet (`ESTATE_CSS`, emitted once as an
 * inline `<style>` at the top of `<body>`) and the `.estate` shell wrapper the
 * old `Page` UiNode component used to provide. A `.page` renders
 * `<html><head>…</head><body>{layout(component)}</body></html>`, so the layout
 * wraps the body content; the head (title/meta) comes from each page's
 * `metadata`. One layout, shared by the marketing, MLS, and style-guide pages.
 */

import type { ReactNode } from "react";

import { ESTATE_CSS } from "./styles";

export function EstateLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="estate">
      <style>{ESTATE_CSS}</style>
      {children}
    </div>
  );
}
