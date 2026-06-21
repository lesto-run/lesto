/**
 * `<Link>` — an ordinary anchor that soft nav upgrades.
 *
 * The deliberate non-magic of Lesto's client router: a `Link` renders a real
 * `<a href>`, nothing more. It works with JS off (a normal navigation), it is
 * crawlable, it is an anchor in every devtool — and when {@link enableSoftNav} is
 * running, its delegated click listener turns an eligible click into a
 * fetch-and-swap. So the component carries no navigation logic itself; it is the
 * authoring sugar that pairs with the runtime, exactly as a server `<a>` pairs
 * with the browser.
 *
 * Authored with plain `createElement` so it stays in `@lesto/ui`'s isomorphic core
 * (no `react-dom`): it renders the same markup on the server (into the prerendered
 * document) and on the client (inside an island), and the soft-nav runtime reads
 * the rendered anchor, never the component.
 *
 *   <Link href="/listings/7">View listing</Link>
 *   <Link href="/download.pdf" reload>Download</Link>   // opts out → full nav
 */

import { createElement } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";

import type { RouteHref } from "./routes";
import { RELOAD_ATTR } from "./softnav-contract";

/** A `Link`'s props: every native anchor attribute, plus `href` (required) and `reload`. */
export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /**
   * The destination. A same-origin path soft-navigates; anything else falls back to
   * a full nav. Typed as {@link RouteHref}: when the app has route codegen, the
   * known routes autocomplete; otherwise it is `string`, unchanged.
   */
  href: RouteHref;

  /**
   * Force a full document reload for this link, opting OUT of soft nav (renders
   * the {@link RELOAD_ATTR} the runtime declines on). Use it for a link that must
   * re-run the document — a logout that clears client state, a cross-app boundary.
   */
  reload?: boolean;

  children?: ReactNode;
}

/**
 * Render a soft-nav-aware anchor.
 *
 * `reload` is lifted off the DOM props and turned into the `data-lesto-reload`
 * attribute the runtime checks, so it never leaks onto the `<a>` as an unknown
 * boolean attribute. Everything else (`className`, `aria-*`, `onClick`, `rel`, a
 * `target`) passes straight through — a `target="_blank"` link, for instance,
 * still renders normally and the runtime declines to soft-nav it, the correct
 * behavior with no special-casing here.
 */
export function Link({ href, reload, children, ...rest }: LinkProps): ReactNode {
  return createElement(
    "a",
    {
      href,
      ...(reload === true ? { [RELOAD_ATTR]: "" } : {}),
      ...rest,
    },
    children,
  );
}
