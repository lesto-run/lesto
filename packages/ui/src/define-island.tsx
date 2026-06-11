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
 */

import { createElement, Fragment, useId } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";

import { dataPrimerScript } from "./data";
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

    const { mount, props: validated } = islandMount(def, props, id);

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
