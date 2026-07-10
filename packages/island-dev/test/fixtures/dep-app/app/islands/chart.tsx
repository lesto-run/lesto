/**
 * The island that reproduces L-90d2de01: it imports a THIRD-PARTY npm package that is
 * not in the dialect's `optimizeDeps.include` — the shape every real Lesto island takes
 * the moment it reaches for `clsx`, `tailwind-merge`, or `lucide-react` (ADR 0037's
 * first-class shadcn path). `preact-render-to-string` stands in for those: any installed,
 * non-included, optimizable package will do.
 *
 * It must reach the dep through a RELATIVE hop (`../lib/render`), because that is the
 * shape that defeats a naive "read the island files" pre-scan: the bare specifier lives
 * one module deeper than the island itself.
 */

import type { ReactElement } from "react";

import { toHtml } from "../lib/render";

function defineIsland<T>(options: T): T {
  return options;
}

function Chart(): ReactElement {
  return <pre>{toHtml(<b>hi</b>)}</pre>;
}

export default defineIsland({ name: "Chart", component: Chart });
