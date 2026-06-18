/**
 * Resource hints over React 19's native resource APIs.
 *
 * React 19 turns `preload`/`preinit`/`preconnect`/`prefetchDNS` (from `react-dom`)
 * and document-metadata tags into real `<link>`/`<script>` elements during SSR —
 * and it does so even under the framework's buffered `renderToStaticMarkup`
 * render, hoisting them to the FRONT of the emitted markup. That is the whole
 * Tier-0 win: the browser learns about the LCP image, fonts, and island bundles
 * before it has finished parsing the body, with no streaming and no new transport.
 *
 * This module is a thin, Volo-flavored seam over those primitives. Two reasons it
 * exists rather than telling callers to import `react-dom` directly:
 *   - the `react-dom` resource functions are imperative side effects that only
 *     register a hint while a render is in flight; wrapping them keeps the import
 *     surface small and lets us inject a fake registrar in tests (no real render
 *     needed to prove we called the right thing with the right options);
 *   - the LCP-image and island-bundle conventions (`fetchpriority="high"`,
 *     `<link rel="modulepreload">`) are Volo decisions, not React ones, and belong
 *     in one named place.
 *
 * The element-returning helpers (`lcpImage`, `modulePreload`) emit React elements
 * the caller drops into the tree; React hoists the `<link>`s itself. The
 * imperative helpers (`preload`/`preinit`/…) register a hint as a side effect and
 * return nothing — call them from inside a component's render.
 */

import { createElement } from "react";
import type { ReactElement } from "react";
import {
  preconnect as reactPreconnect,
  prefetchDNS as reactPrefetchDNS,
  preinit as reactPreinit,
  preinitModule as reactPreinitModule,
  preload as reactPreload,
} from "react-dom";

/**
 * The subset of React's resource API we lean on, named as one seam so a test can
 * substitute a recorder and assert the exact calls without rendering. The shapes
 * mirror `react-dom`'s own (intentionally loose option bags — React validates).
 */
export interface ResourceRegistrar {
  preload: (href: string, options: PreloadOptions) => void;
  preinit: (href: string, options: PreinitOptions) => void;
  preinitModule: (href: string, options?: PreinitModuleOptions) => void;
  preconnect: (href: string, options?: PreconnectOptions) => void;
  prefetchDNS: (href: string) => void;
}

/** Options for a `preload` hint — `as` is required; the rest mirror react-dom. */
export interface PreloadOptions {
  as:
    | "audio"
    | "document"
    | "embed"
    | "fetch"
    | "font"
    | "image"
    | "object"
    | "script"
    | "style"
    | "track"
    | "video"
    | "worker";
  crossOrigin?: "anonymous" | "use-credentials";
  integrity?: string;
  type?: string;
  fetchPriority?: "high" | "low" | "auto";
  imageSrcSet?: string;
  imageSizes?: string;
}

/** Options for a `preinit` hint — load AND execute/apply a script or stylesheet. */
export interface PreinitOptions {
  as: "script" | "style";
  precedence?: string;
  crossOrigin?: "anonymous" | "use-credentials";
  integrity?: string;
  fetchPriority?: "high" | "low" | "auto";
}

/** Options for a `preinitModule` hint — load AND execute an ES module. */
export interface PreinitModuleOptions {
  as?: "script";
  crossOrigin?: "anonymous" | "use-credentials";
  integrity?: string;
}

/** Options for a `preconnect` hint — open the connection early. */
export interface PreconnectOptions {
  crossOrigin?: "anonymous" | "use-credentials";
}

/** The real react-dom functions, the default registrar everywhere but tests. */
const reactRegistrar: ResourceRegistrar = {
  preload: reactPreload,
  preinit: reactPreinit,
  preinitModule: reactPreinitModule,
  preconnect: reactPreconnect,
  prefetchDNS: reactPrefetchDNS,
};

/**
 * Register a `preload` hint: fetch `href` early at the given priority, but do not
 * execute it. The browser caches it for the moment the parser reaches the real
 * reference. React hoists the resulting `<link rel="preload">` into the document.
 */
export function preload(
  href: string,
  options: PreloadOptions,
  registrar: ResourceRegistrar = reactRegistrar,
): void {
  registrar.preload(href, options);
}

/**
 * Register a `preinit` hint: fetch AND execute/apply `href` early. Use it for a
 * critical script or stylesheet whose effect the page needs as soon as possible.
 */
export function preinit(
  href: string,
  options: PreinitOptions,
  registrar: ResourceRegistrar = reactRegistrar,
): void {
  registrar.preinit(href, options);
}

/**
 * Register a `preinitModule` hint: fetch AND execute an ES module early. This
 * EXECUTES the module — for execute-free hint use {@link modulePreload} instead.
 */
export function preinitModule(
  href: string,
  options?: PreinitModuleOptions,
  registrar: ResourceRegistrar = reactRegistrar,
): void {
  // Forward `options` only when given: react-dom's signature makes it optional,
  // and passing an explicit `undefined` under exactOptionalPropertyTypes is noise.
  if (options === undefined) {
    registrar.preinitModule(href);

    return;
  }

  registrar.preinitModule(href, options);
}

/**
 * Register a `preconnect` hint: open the TCP+TLS connection to `href`'s origin
 * before the first request to it, shaving the handshake off the critical path.
 */
export function preconnect(
  href: string,
  options?: PreconnectOptions,
  registrar: ResourceRegistrar = reactRegistrar,
): void {
  if (options === undefined) {
    registrar.preconnect(href);

    return;
  }

  registrar.preconnect(href, options);
}

/**
 * Register a `prefetchDNS` hint: resolve `href`'s DNS early. Cheaper than
 * `preconnect` (no socket), for an origin you are likely — but not certain — to hit.
 */
export function prefetchDNS(href: string, registrar: ResourceRegistrar = reactRegistrar): void {
  registrar.prefetchDNS(href);
}

/** Optional attributes for {@link lcpImage} beyond the load-bearing ones. */
export interface LcpImageProps {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  className?: string;
  sizes?: string;
  srcSet?: string;
}

/**
 * The hero image, marked as the Largest Contentful Paint candidate.
 *
 * `fetchpriority="high"` tells the browser to prioritize this fetch over the
 * default-`low` images; React 19 *also* auto-emits a `<link rel="preload"
 * as="image" fetchpriority="high">` from an `<img fetchPriority>` during SSR, so
 * the hint reaches the browser in the document head before the body is parsed —
 * the single highest-ROI LCP lever. We never lazy-load the LCP image (`loading`
 * stays eager) for the same reason: deferring the most important paint is a
 * regression dressed as an optimization.
 */
export function lcpImage(props: LcpImageProps): ReactElement {
  return createElement("img", {
    src: props.src,
    alt: props.alt,
    // React 19 emits this in its DOM-property casing (`fetchPriority`), which the
    // browser reads case-insensitively; it also auto-emits a `<link rel="preload"
    // as="image">` from an `<img fetchPriority>`. Marking the LCP image is the one
    // place this attribute earns its keep.
    fetchPriority: "high",
    // Spell the load behavior out: an eager LCP image is the point.
    loading: "eager",
    decoding: "async",
    ...(props.width === undefined ? {} : { width: props.width }),
    ...(props.height === undefined ? {} : { height: props.height }),
    ...(props.className === undefined ? {} : { className: props.className }),
    ...(props.sizes === undefined ? {} : { sizes: props.sizes }),
    ...(props.srcSet === undefined ? {} : { srcSet: props.srcSet }),
  });
}

/**
 * A `<link rel="modulepreload">` for an island's client bundle.
 *
 * `modulepreload` fetches AND compiles a module graph WITHOUT executing it — the
 * right hint for code that runs only after hydration. (Contrast `preinitModule`,
 * which executes.) React hoists this `<link>` into the head, so the island's JS
 * is parsed and ready the moment `hydrateIslands` reaches for it.
 */
export function modulePreload(
  href: string,
  crossOrigin?: "anonymous" | "use-credentials",
): ReactElement {
  return createElement("link", {
    rel: "modulepreload",
    href,
    ...(crossOrigin === undefined ? {} : { crossOrigin }),
  });
}
