/**
 * Build an island's wire `IslandMount` from its declaration — the single author
 * of those bytes, shared by the two server paths that emit islands:
 *
 *   - `buildIsland` (render.tsx) — the Registry/`UiNode` tree path, one page-wide
 *     `#keel-islands` manifest array;
 *   - `defineIsland` (define-island.ts) — the `.page` path (ADR 0011), one
 *     co-located mount script per island.
 *
 * Both must produce byte-identical mount shapes (props validated + serializable,
 * `ssr`, the optional `strategy`/`bind` emitted only when they deviate from the
 * default), so the shape lives here once rather than drifting between them.
 */

import { dataSourceHref } from "./data";
import type { IslandBind } from "./data";
import type { ClientComponentDef, IslandMount } from "./island";
import { validateProps } from "./props";
import { assertSerializable } from "./serialize";

/**
 * Validate `rawProps` against the island's schema, prove them serializable, and
 * assemble the wire mount. Returns the mount AND the validated props (the caller
 * renders the fallback / ssr output from the same validated bag). May throw
 * `UI_ISLAND_PROPS_NOT_SERIALIZABLE` — the caller decides whether to contain it.
 *
 * `resolved` is the render-time-resolved data (ADR 0012, the canonical island):
 * when present, its entries are merged into the props AFTER schema validation
 * (bound props were never schema-validated — they bypass `validateProps` on the
 * client path today, kept symmetric) and BEFORE `assertSerializable` (inlined
 * data rides the wire, so it passes the same JSON guard). A `bind` is then
 * emitted only for `def.data` entries NOT in `resolved` (e.g. a `visible`
 * island's deferred source). The Registry path (`buildIsland`) passes nothing,
 * so its mount is byte-for-byte unchanged.
 */
export function islandMount(
  def: ClientComponentDef,
  rawProps: Record<string, unknown>,
  id: string,
  resolved?: Record<string, unknown>,
): { mount: IslandMount; props: Record<string, unknown> } {
  const validated = def.props === undefined ? rawProps : validateProps(def.props, rawProps).props;

  // Inlined data merges OVER the validated props (a bound prop wins over a static
  // one of the same name), then the whole bag must pass the serialize guard.
  const props = resolved === undefined ? validated : { ...validated, ...resolved };

  const serializable = assertSerializable(def.name, props);

  const mount: IslandMount = {
    id,
    component: def.name,
    props: serializable,
    ssr: def.ssr === true,
  };

  // `strategy`/`bind` ride the wire only when they deviate from the default, so a
  // plain eager island's mount is byte-for-byte what it has always been.
  if (def.hydrate === "visible") {
    mount.strategy = "visible";
  }

  if (def.data !== undefined) {
    const bind: Record<string, IslandBind> = {};

    for (const [prop, source] of Object.entries(def.data)) {
      // A source already resolved into props needs no client-side bind — its
      // value crossed the wire inline. Only unresolved sources keep a bind.
      if (resolved !== undefined && prop in resolved) continue;

      bind[prop] = { source: source.name, href: dataSourceHref(source.name) };
    }

    // Emit `bind` only when at least one source is still unresolved, so a fully
    // inlined island's wire entry has no `bind` key at all (byte-stable).
    if (Object.keys(bind).length > 0) {
      mount.bind = bind;
    }
  }

  return { mount, props };
}
