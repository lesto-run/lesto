/**
 * The soft-nav CONTRACT — the DOM-free constants and types both halves share.
 *
 * `<Link>` (isomorphic, `link.tsx`) and the runtime (`enableSoftNav`, `softnav.ts`,
 * browser-only) both need the opt-out attribute name and the shape of an eligible
 * anchor/click. Putting them here — a module that imports NOTHING from the DOM or
 * `react-dom` — lets `Link` stay in `@lesto/ui`'s isomorphic core without dragging
 * the client hydration runtime (`react-dom/client`) into a server build. The
 * runtime re-exports these alongside its own seams, so a caller sees one surface.
 */

/** The attribute that opts a link OUT of soft nav — forcing a full document reload. */
export const RELOAD_ATTR = "data-lesto-reload";

/**
 * The attribute that opts a link INTO prefetch — warming the soft-nav fetch of its
 * destination before the click, so the navigation feels instant. `<Link prefetch>`
 * stamps it; the browser runtime ({@link PrefetchStrategy}-aware) reads it.
 *
 * Its VALUE is the {@link PrefetchStrategy}: `"viewport"` (prefetch when the link
 * scrolls into view) or `"hover"` (prefetch on pointer-enter / focus). A bare
 * `prefetch` (boolean `true`) renders the value `"viewport"` — the cheaper-by-default
 * eager strategy peer routers use, since a hover is already late for an instant feel.
 *
 * DOM-free like {@link RELOAD_ATTR}: it is just an attribute name + value contract
 * `<Link>` (isomorphic) writes and the runtime (browser) reads, so neither half
 * dictates the other's environment.
 */
export const PREFETCH_ATTR = "data-lesto-prefetch";

/**
 * When a prefetch fires for a link. `"viewport"` warms the fetch when the anchor
 * scrolls into view (eager, IntersectionObserver-driven); `"hover"` warms it on
 * pointer-enter or keyboard focus (lazy, intent-driven). A bare `<Link prefetch>`
 * is `"viewport"`.
 */
export type PrefetchStrategy = "viewport" | "hover";

/**
 * The attribute that marks a layout-boundary element in the streamed document, so a
 * soft navigation can do a LAYOUT-PRESERVING PARTIAL SWAP: replace only the inner
 * subtree that changed, keeping the outer layout DOM (and its island state) mounted.
 *
 * Its VALUE is the layout's depth as a decimal string (`"0"` outermost, growing
 * inward), the `layoutDepth` the router already computes — so the runtime can align
 * the live and fetched layout chains by a shared prefix of depths and swap only
 * below the deepest common layout.
 *
 * The runtime treats this as ENTIRELY OPTIONAL: a document with no such markers
 * falls back to the full-body swap, so this never becomes load-bearing. EMITTING the
 * marker is the server renderer's job — `@lesto/web`'s `wrap` (`render-page.tsx`,
 * shared by the app-level and file-route layout chains) stamps one `display:contents`
 * marker around each layout's children, so a page with layouts gets a marker per
 * layout depth and the partial swap activates; a page with none emits no marker and
 * the full-body swap runs, with no regression.
 */
export const LAYOUT_ATTR = "data-lesto-layout";

/**
 * Resolve a `<Link prefetch>` prop to the attribute VALUE to render, or `undefined`
 * when the link does not prefetch.
 *
 * `true` → `"viewport"` (the eager default); an explicit `"viewport"`/`"hover"`
 * passes through; `false`/`undefined` → `undefined` (no attribute). Pure, shared by
 * `<Link>` (which writes the attribute) so the boolean-sugar rule lives in ONE place
 * the runtime can trust.
 */
export function prefetchAttrValue(
  prefetch: boolean | PrefetchStrategy | undefined,
): PrefetchStrategy | undefined {
  if (prefetch === undefined || prefetch === false) return undefined;

  return prefetch === true ? "viewport" : prefetch;
}

/**
 * The minimal anchor surface soft nav reads — `HTMLAnchorElement` satisfies it.
 * Kept narrow so a test can hand a plain object and the eligibility logic is
 * exercised with no real DOM node.
 */
export interface SoftNavAnchor {
  /** The fully-resolved destination (`a.href`), absolute. */
  href: string;

  /** The link's `target` (`""` for same-frame). A named target declines soft nav. */
  target: string;

  /** Whether the link carries a `download` attribute — a download declines soft nav. */
  hasDownload: boolean;

  /** Whether the link opted out with {@link RELOAD_ATTR}. */
  reload: boolean;
}

/**
 * The slice of a click event soft nav inspects. A modifier click, a non-primary
 * button, or an already-defaulted event all decline soft nav (the user asked for
 * a new tab, or another handler already took the event).
 */
export interface SoftNavClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;

  /** Resolve the eligible anchor this click targets, or `undefined` if none. */
  anchor: () => SoftNavAnchor | undefined;

  /** Suppress the browser's default full navigation — called only when soft nav takes over. */
  preventDefault: () => void;
}

/**
 * Is this click one soft nav should handle? Every decline falls through to the
 * browser's normal navigation, so the floor (a working link) always holds.
 *
 * Declined when: the event was already defaulted by another handler; it is not a
 * plain primary-button click (a middle/right click or any modifier means "new
 * tab / new window / save", the user's explicit ask); or no eligible anchor is in
 * the target's ancestry. An eligible anchor is same-frame, not a download, not
 * opted out — the cross-origin check is the caller's (it needs the page origin).
 *
 * Pure over its inputs (no DOM), so every decline branch is unit-testable with a
 * plain object click.
 */
export function eligibleAnchor(click: SoftNavClick): SoftNavAnchor | undefined {
  // Another handler already took this event (a framework menu, a confirm dialog).
  if (click.defaultPrevented) return undefined;

  // Only a plain left click is a navigation; anything else is the user asking for
  // a new tab/window or a context menu, which a soft swap must not steal.
  if (click.button !== 0) return undefined;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return undefined;

  const anchor = click.anchor();

  if (anchor === undefined) return undefined;

  // A named target (new frame/tab), a download, or an explicit opt-out all want
  // the real navigation, not a same-document swap.
  if (anchor.target !== "" || anchor.hasDownload || anchor.reload) return undefined;

  return anchor;
}
