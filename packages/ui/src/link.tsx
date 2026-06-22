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

import type { RouteHref, StrictRouteHref } from "./routes";
import { PREFETCH_ATTR, prefetchAttrValue, RELOAD_ATTR } from "./softnav-contract";
import type { PrefetchStrategy } from "./softnav-contract";

/** A `Link`'s props: every native anchor attribute, plus `href` (required), `reload`, `prefetch`. */
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

  /**
   * Opt this link INTO prefetch — warming the soft-nav fetch of its destination
   * before the click, so the navigation feels instant. Renders the
   * {@link PREFETCH_ATTR} the runtime reads; a server build with no soft-nav runtime
   * (or one that declines the link, e.g. cross-origin) simply ignores it.
   *
   *   - `"viewport"` (or bare `prefetch` / `prefetch={true}`) — warm when the link
   *     scrolls into view (eager, the cheaper-feeling default).
   *   - `"hover"` — warm on pointer-enter / keyboard focus (lazy, intent-driven).
   *   - `false`/omitted — no prefetch (the default; existing links are unchanged).
   *
   * Opt-in and additive: the runtime never warms a cross-origin or `route()`-escape
   * href, so a marked external link is a harmless no-op.
   */
  prefetch?: boolean | PrefetchStrategy;

  children?: ReactNode;
}

/**
 * Render a soft-nav-aware anchor.
 *
 * `reload` and `prefetch` are lifted off the DOM props and turned into the
 * `data-lesto-reload` / `data-lesto-prefetch` attributes the runtime reads, so
 * neither leaks onto the `<a>` as an unknown attribute. `prefetch` renders only
 * when it resolves to a strategy ({@link prefetchAttrValue}: `true` → `"viewport"`,
 * `false`/omitted → nothing), so an un-prefetched link is byte-for-byte the anchor
 * it always was. Everything else (`className`, `aria-*`, `onClick`, `rel`, a
 * `target`) passes straight through — a `target="_blank"` link, for instance,
 * still renders normally and the runtime declines to soft-nav it, the correct
 * behavior with no special-casing here.
 */
export function Link({ href, reload, prefetch, children, ...rest }: LinkProps): ReactNode {
  const prefetchValue = prefetchAttrValue(prefetch);

  return createElement(
    "a",
    {
      href,
      ...(reload === true ? { [RELOAD_ATTR]: "" } : {}),
      ...(prefetchValue === undefined ? {} : { [PREFETCH_ATTR]: prefetchValue }),
      ...rest,
    },
    children,
  );
}

/** The props {@link StrictLink} takes: a `Link`'s, but with a STRICT {@link StrictRouteHref}. */
export type StrictLinkProps = Omit<LinkProps, "href"> & { href: StrictRouteHref };

/**
 * `<StrictLink>` — `<Link>` with a STRICT href: only the app's known routes, no escape,
 * so a typo'd `href` is a `tsc` error (the "a bad link won't compile" win, BY DEFAULT —
 * no `route()` wrapper needed). It IS `Link`, re-typed: runtime-identical, zero new code.
 *
 * For a FULLY-file-routed app, where the codegen registry is the complete route set. A
 * MIXED app (with code-first `.page()` routes) keeps `<Link>` — strict here would
 * false-positive on those (see {@link StrictRouteHref}).
 */
export const StrictLink: (props: StrictLinkProps) => ReactNode = Link;
