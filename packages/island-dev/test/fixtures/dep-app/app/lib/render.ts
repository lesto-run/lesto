/**
 * A relative module the island reaches through — so the third-party bare specifier is
 * one hop deeper than the island file itself (see `../islands/chart.tsx`).
 */

import { render } from "preact-render-to-string";

import type { ReactElement } from "react";

export function toHtml(node: ReactElement): string {
  return render(node as never);
}
