/**
 * Islands — client-hydrated regions inside an otherwise static tree.
 *
 * The premise of *auth-aware static*: a page is prerendered to HTML once, but a
 * few regions ("My Account", a cart count, a live price) must resolve on the
 * client, per-visitor, after hydration. An island is the boundary between the
 * two worlds.
 *
 * The author's experience stays uniform: an island is an ordinary `UiNode`. Its
 * `type` names a *client* component the registry knows about, and its `props`
 * are plain JSON that will cross the server -> client wire. The `island(...)`
 * helper is sugar for writing that node by hand.
 *
 * A client component is declared with `defineClient` and differs from a server
 * `ComponentDef` in three honest ways:
 *   - it carries no server `render`; the only thing the server can emit is an
 *     optional `fallback` placeholder (skeleton, last-known value, nothing);
 *   - its real implementation is a React `component`, mounted on the client;
 *   - the engine treats its `props` as a wire payload — they MUST be
 *     JSON-serializable, since a function or a class instance cannot survive the
 *     trip to the browser.
 *
 * Two flavors of island, distinguished by `ssr`:
 *   - **Deferred (default, `ssr` absent/false)** — the classic auth-aware-static
 *     island. The server CANNOT render the real component (it depends on the
 *     signed-in user the prerender never knew), so it ships only the `fallback`,
 *     and the client mounts the live component *fresh* (`createRoot`), swapping
 *     the fallback for per-visitor truth. `hydrateRoot` would throw a mismatch
 *     here, because the shell never held the component's real output.
 *   - **SSR-able (`ssr: true`)** — the author asserts the server CAN render the
 *     real component and that the client render will MATCH it. The server emits
 *     the component's actual output into the shell, and the client `hydrateRoot`s
 *     it: real hydration that reuses the server DOM and gains React 19's
 *     hydration resilience, with no re-render and no mismatch.
 *
 * The default is deferred because that is the safe one: declaring `ssr` is an
 * explicit promise that server and client agree, and a broken promise is a
 * hydration mismatch — worse than a fresh mount. We never assume it.
 */

import type { ComponentType, ReactNode } from "react";

import type { DataSource, IslandBind } from "./data";
import type { PropSpec, UiNode } from "./types";

/**
 * A client component: the unit an island mounts on the browser.
 *
 * `props` is an optional `PropSpec` schema, validated exactly like a server
 * component's props (required/enum/coercion all reuse the same validator).
 * `fallback` renders the server-side placeholder; absent, the island ships an
 * empty shell to be filled in on hydration.
 *
 * `ssr` opts the island into real hydration: the server renders the REAL
 * `component` into the shell (not the fallback), and the client `hydrateRoot`s
 * it. Only set it when the component renders identically on both sides — see the
 * module doc. When `ssr` is true the `fallback` is unused (the real output IS the
 * server markup) and may be omitted.
 *
 * `hydrate` chooses WHEN the client does the island's mount work, mirroring how
 * `ssr` chooses WHICH shell the server ships — a per-component declaration, not a
 * page-wide mode:
 *   - **`"load"` (default)** — eager: the island mounts as soon as
 *     `hydrateIslands` runs, the behavior every existing island already has.
 *   - **`"visible"`** — lazy: the island does not mount until its region first
 *     scrolls into view (an `IntersectionObserver`), Astro's `client:visible`
 *     analogue. For Keel's deferred Account island this also defers its on-mount
 *     `/mls/api/session` fetch until the region is actually seen.
 *
 * Honest scope: Keel ships ONE client bundle, so `"visible"` defers the island's
 * MOUNT WORK (its render, effects, and fetches). Whether it also defers the
 * island's BYTES depends on the declaration form below: an eager `component`
 * already shipped in the main bundle, while a lazy `load` arrives as its own
 * chunk only when the mount actually happens.
 *
 * A client component is declared in one of two forms, and the split is what
 * makes per-island code-splitting real:
 *
 *   - **Eager (`component`)** — the component function is referenced directly,
 *     so its code ships in the main client bundle. Required for `ssr: true`
 *     (the server must hold the real component to render it into the shell).
 *
 *   - **Lazy (`load`)** — the def carries a `() => import(...)`-shaped loader
 *     instead of the component itself. A bundler with code-splitting turns that
 *     dynamic import into a separate chunk, so the island's BYTES stay out of
 *     the main bundle and only arrive when the island actually mounts. Combined
 *     with `hydrate: "visible"` this is true byte deferral: a below-the-fold
 *     island costs nothing — no code, no work — until it scrolls into view.
 *     A lazy island is necessarily deferred (`ssr` cannot be `true`): the server
 *     cannot SSR a component it does not hold, only its `fallback`.
 *
 * The two forms are a discriminated union, not two optional fields: exactly one
 * of `component`/`load` is present, the compiler enforces `ssr: true` only on
 * the eager form, and `defineClient` re-checks both rules at runtime for
 * un-typed callers.
 */
export type ClientComponentDef = EagerClientComponentDef | LazyClientComponentDef;

/** The declaration fields shared by both forms of client component. */
interface ClientComponentBase {
  name: string;
  description?: string;
  props?: Record<string, PropSpec>;
  fallback?: (props: Record<string, unknown>) => ReactNode;
  hydrate?: HydrationStrategy;

  /**
   * Per-request data this island needs, as `propName → source token` (ADR
   * 0010). The framework resolves each source and hands the value to the
   * component as that prop — so the component is a pure function of props with
   * no `fetch`-in-effect, and a waterfall has no author-side site to exist at.
   * The source's implementation is bound on the server (`keel().data(...)`);
   * this only names the binding, so the client bundle pulls in no server code.
   */
  data?: Record<string, DataSource>;
}

/** An island whose component ships in the main bundle (and may be `ssr: true`). */
export interface EagerClientComponentDef extends ClientComponentBase {
  component: ComponentType<Record<string, unknown>>;
  load?: never;
  ssr?: boolean;
}

/**
 * An island whose component arrives as its own chunk, fetched on mount.
 *
 * `load` resolves the component — canonically `() => import("./x").then(m => m.X)`
 * so the bundler splits it. The island is always deferred (`ssr` is not
 * declarable): its server shell is the `fallback`, and the client swaps it for
 * the loaded component with a fresh mount once the chunk arrives.
 */
export interface LazyClientComponentDef extends ClientComponentBase {
  load: () => Promise<ComponentType<Record<string, unknown>>>;
  component?: never;
  ssr?: false;
}

/**
 * When the client mounts an island. `"load"` is eager (today's only behavior);
 * `"visible"` defers the mount until the region first intersects the viewport.
 * Kept as a named type because it rides both the authoring side
 * ({@link ClientComponentDef.hydrate}) and the wire ({@link IslandMount.strategy}).
 */
export type HydrationStrategy = "load" | "visible";

/**
 * One hydration target: enough for ANY client runtime to find the marked DOM
 * element and mount the right component with the right props. This is the wire
 * contract between `renderPage` (server) and `hydrateIslands` (client).
 *
 * `ssr` tells the client whether the shell already holds the component's real
 * server-rendered output (`hydrateRoot`) or only a fallback to replace
 * (`createRoot`). It rides the wire so the client never has to guess and never
 * risks a mismatch by hydrating a fallback-only shell.
 *
 * `strategy` tells the client WHEN to do that mount: `"visible"` defers it to the
 * region's first intersection, anything else (including its absence) mounts
 * eagerly. It is OPTIONAL and omitted for the default `"load"` so an eager
 * island's wire entry stays byte-for-byte what it has always been — existing
 * manifests, their serialized `<script>` payloads, and the tests that pin their
 * exact shape all read unchanged. Only the rarer `"visible"` opt-in adds a field.
 */
export interface IslandMount {
  id: string;
  component: string;
  props: Record<string, unknown>;
  ssr: boolean;
  strategy?: HydrationStrategy;

  /**
   * Per-prop data bindings the client must resolve before mounting (ADR 0010),
   * `propName → { source, href }`. Present only on an island with a `data`
   * declaration whose values were NOT resolved server-side; a dynamically
   * rendered page inlines the values into `props` and omits `bind` entirely, so
   * a data-free or server-resolved island's wire entry is byte-for-byte what it
   * always was. The client awaits each source (the parse-time primer promise on
   * `window.__keelData`, else a fetch of `href`) and merges it into props.
   */
  bind?: Record<string, IslandBind>;
}

/** The attribute that marks an island's wrapper element for hydration. */
export const ISLAND_ATTR = "data-keel-island";

/**
 * Author an island node by hand-free sugar: `island("Account", { plan: "pro" })`.
 * It is exactly the `UiNode` you would have written — nothing magic, so it
 * composes as a child anywhere a node is allowed.
 */
export function island(name: string, props: Record<string, unknown> = {}): UiNode {
  return { type: name, props };
}
