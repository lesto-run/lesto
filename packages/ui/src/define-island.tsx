/**
 * `defineIsland` — a self-describing island usable directly in a `.page` (ADR 0011).
 *
 * Where the Registry/`UiNode` path collects every island into one page-wide
 * `#keel-islands` manifest emitted after the body, a `.page` is a plain React
 * tree with nothing to walk. So an island describes ITSELF at render time: the
 * component `defineIsland` returns emits, co-located in the stream, its marked
 * shell, its own mount script, and (for bound data) its primer — siblings, not
 * children, so the hydration container is exactly the shell and nothing else.
 *
 *   export default defineIsland({ name: "Account", component: Account,
 *     fallback: AccountFallback, data: { session: sessionSource } });
 *   // in a page:  <AccountIsland />
 *
 * Co-located emission is streaming-safe by construction: an island inside a late
 * `<Suspense>` boundary flushes with its own mount script, so there is no
 * "manifest after the body" ordering problem, and its primer fires the instant
 * the parser reaches it. The client (`hydrateDocumentIslands`) scans the mount
 * scripts and feeds the same `hydrateIslands` machinery — binds, strategies, and
 * mount resilience all unchanged.
 *
 * The returned component carries its `.island` def so the build's client-entry
 * synthesizer (`@keel/assets`) and the client registry can read it from the
 * island's module without a separate registration.
 *
 * ## Data resolution rule (ADR 0012, the canonical island)
 *
 * The component reads {@link IslandDataContext}. What it does with a `data`
 * declaration depends on whether a render-time resolver is in scope (dynamic
 * page) and on the island's own `ssr`/`hydrate`:
 *
 * | resolver | ssr     | hydrate     | behavior                                            |
 * |----------|---------|-------------|-----------------------------------------------------|
 * | present  | `true`  | any         | resolve ALL sources via `use()`, inline into props, |
 * |          |         |             | no bind, no primer; shell = the REAL component WITH  |
 * |          |         |             | the data (the canonical island — no fallback flash). |
 * | present  | falsy   | ≠ `visible` | resolve + inline too (0 RTT; the client `createRoot`s|
 * |          |         |             | with complete props), no bind, no primer.           |
 * | present  | falsy   | `visible`   | do NOT resolve (work deferred with the mount); emit  |
 * |          |         |             | bind, no primer (item 2's filter); fetch-on-view.   |
 * | absent   | `true`  | (has data)  | THROW `UI_ISLAND_SSR_DATA_UNRESOLVED` — on a static  |
 * |          |         |             | doc this would inline per-user bytes or guarantee a  |
 * |          |         |             | mismatch; the build fails (ADR 0012, by design).    |
 * | absent   | falsy   | any         | today's behavior: bind + primer (the static tier).  |
 */

import { createElement, Fragment, use, useContext, useId } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";

import { dataPrimerScript } from "./data";
import { IslandDataContext } from "./data-resolve";
import type { SourceResolver } from "./data-resolve";
import { UiError } from "./errors";
import { assertClientDef, ISLAND_ATTR, ISLAND_MOUNT_ATTR } from "./island";
import type { ClientComponentDef } from "./island";
import { islandMount } from "./mount";
import { serializeScriptJson } from "./serialize";

/** A React component for a `.page`, carrying its island declaration for the build + client registry. */
export interface IslandComponent {
  (props: Record<string, unknown>): ReactElement;

  /** The island's declaration — read by the entry synthesizer and the client registry. */
  readonly island: ClientComponentDef;
}

/**
 * Resolve a `data`-declared island's sources at render time, or decide not to,
 * per the resolution-rule table in the module doc. Returns the `{ prop: value }`
 * bag to inline (and so omit each resolved source's `bind`), or `undefined` to
 * keep the static bind + primer behavior.
 *
 * `use()` may be called here in a loop and conditionally — it is the one React
 * Hook that may. A real promise suspends the render (Suspense + the stream's 10s
 * deadline own that); a sync loader's pre-fulfilled thenable reads synchronously.
 */
function resolveData(
  def: ClientComponentDef,
  resolver: SourceResolver | null,
): Record<string, unknown> | undefined {
  if (def.data === undefined) return undefined;

  if (resolver === null) {
    // No render-time resolver in scope. An `ssr: true` + `data` island here is a
    // static/prerender emission of per-user bytes into a shared-cacheable
    // document — impossible, not inconvenient: refuse loudly (ADR 0012). A
    // deferred island keeps today's bind + primer behavior (the static tier).
    if (def.ssr === true) {
      throw new UiError(
        "UI_ISLAND_SSR_DATA_UNRESOLVED",
        `island "${def.name}" is ssr: true with data bindings but no data resolver is in scope — on a static/prerendered document this would inline per-user bytes or guarantee a hydration mismatch; render it on a dynamic page or drop ssr`,
        { name: def.name },
      );
    }

    return undefined;
  }

  // A `visible` (lazy-mount) island's data is deferred along with its mount, so
  // it is NOT resolved at render even under a resolver — it keeps its bind and
  // fetches on first intersection (the meaning of "visible").
  if (def.ssr !== true && def.hydrate === "visible") return undefined;

  // Resolve every bound source (memoized: two islands binding one source share a
  // single loader run) and inline the values.
  const inlined: Record<string, unknown> = {};

  for (const [prop, source] of Object.entries(def.data)) {
    inlined[prop] = use(resolver.resolve(source.name));
  }

  return inlined;
}

/**
 * Wrap a {@link ClientComponentDef} into a `.page`-usable React component that
 * self-emits its shell + mount script + data primer.
 *
 * The shell is the `ssr: true` real render or the deferred `fallback`; the mount
 * script and primer are SIBLINGS of the shell wrapper so the client's
 * `createRoot`/`hydrateRoot` adopts only the shell (a script inside the
 * container would mismatch hydration). A non-serializable prop throws out of the
 * render exactly as the Registry path's does — the page's error boundary owns it.
 */
export function defineIsland(def: ClientComponentDef): IslandComponent {
  // The `.page` path never passes through a Registry, so the union rules are
  // enforced here at wrap time (module init): an un-typed caller can hand
  // `defineIsland` a broken union too.
  assertClientDef(def);

  function Island(props: Record<string, unknown>): ReactElement {
    const id = useId();

    const resolver = useContext(IslandDataContext);

    // Decide whether to resolve this island's data AT RENDER (the canonical,
    // dynamic tier) and inline it, per the table in the module doc.
    const resolved = resolveData(def, resolver);

    const { mount, props: validated } = islandMount(def, props, id, resolved);

    const shell: ReactNode =
      mount.ssr && def.component !== undefined
        ? createElement(def.component as ComponentType<Record<string, unknown>>, mount.props)
        : (def.fallback?.(validated) as ReactNode);

    const primer = mount.bind === undefined ? "" : dataPrimerScript([mount]);

    return createElement(
      Fragment,
      null,
      createElement("div", { [ISLAND_ATTR]: id }, shell),
      createElement("script", {
        type: "application/json",
        [ISLAND_MOUNT_ATTR]: "",
        // serializeScriptJson is the one audited escape; dangerouslySetInnerHTML
        // is required because React would HTML-entity-escape text children, which
        // is NOT decoded inside <script> and would corrupt the JSON.
        dangerouslySetInnerHTML: { __html: serializeScriptJson(mount) },
      }),
      ...(primer === ""
        ? []
        : [createElement("script", { dangerouslySetInnerHTML: { __html: primer } })]),
    );
  }

  Island.island = def;

  return Island;
}
