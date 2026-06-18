/**
 * The Preact server-render dialect — re-exported from the `@volo/ui/server`
 * subpath as `preactServerRenderer`.
 *
 * This is the adapter half of the {@link ServerRenderer} seam (declared in
 * `render.tsx`). It backs the two functions {@link renderPageMarkup} needs with
 * `preact-render-to-string` instead of `react-dom/server`, so a page whose client
 * bundle is Preact (the opt-in `react`→`preact/compat` alias, ADR 0007) renders
 * its server markup in the SAME dialect the client will hydrate against.
 *
 * Why this matters, mechanically: an `ssr: true` island ships its real server
 * render into the shell for the client to `hydrateRoot`. Hydration only succeeds
 * when the server- and client-emitted markup agree, and React and Preact do NOT
 * emit identical markup — most visibly, React delimits adjacent text segments with
 * `<!-- -->` comment markers while Preact does not. Hydrate React's server markup
 * with Preact's `hydrateRoot` and the common interpolated-text shape (`'Hi, ',
 * name`) mismatches, firing `onRecoverableError` and forcing a full re-render —
 * defeating `ssr: true`. Rendering the server side with THIS adapter removes the
 * mismatch at the source: both sides speak Preact, so the markup lines up.
 *
 * Why it lives behind `@volo/ui/server` (not the core barrel): keeping `@volo/ui`
 * dialect-agnostic means its core never hard-depends on `preact-render-to-string`.
 * A server importer of `@volo/ui` (the default React path, estate's `document.ts`)
 * must never drag Preact's renderer into its build. So `preact-render-to-string` is
 * an OPTIONAL peer dependency — present only when an adopter chooses the Preact
 * client alias — and this module is the only place that imports it. Reach for it
 * explicitly (`import { preactServerRenderer } from "@volo/ui/server"`) and pass it
 * to {@link renderPageMarkup}; the default React path never loads this file.
 *
 * The `as` cast at the call boundary is the honest cost of bridging two element
 * factories: `@volo/ui` builds its tree with React's `createElement`, and under
 * the `preact/compat` alias those calls resolve to Preact-shaped vnodes that
 * `preact-render-to-string` renders natively. The adapter's job is purely to map
 * the engine's `ReactElement`-typed node onto that renderer's `VNode` parameter;
 * the runtime shape is already a Preact vnode wherever this adapter is wired.
 */

import type { ReactElement } from "react";
// `preact-render-to-string` mirrors `react-dom/server`'s two entry points, which
// is exactly the surface {@link ServerRenderer} asks for — so the adapter is a
// direct one-to-one binding, not a translation layer.
import { renderToStaticMarkup, renderToString } from "preact-render-to-string";

import type { ServerRenderer } from "./render";

/**
 * The Preact dialect, ready to hand to {@link renderPageMarkup} as its `renderer`.
 *
 * Both functions forward straight to `preact-render-to-string`. The node arrives
 * typed as `ReactElement` (the engine's element type), but at runtime — under the
 * `preact/compat` alias that makes this adapter meaningful — it is a Preact vnode,
 * which is what `preact-render-to-string` consumes. The cast names that bridge
 * rather than widening either library's public types.
 */
export const preactServerRenderer: ServerRenderer = {
  dialect: "preact",
  renderToString: (node: ReactElement) => renderToString(node as never),
  renderToStaticMarkup: (node: ReactElement) => renderToStaticMarkup(node as never),
};
