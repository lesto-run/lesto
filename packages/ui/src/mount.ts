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
 */
export function islandMount(
  def: ClientComponentDef,
  rawProps: Record<string, unknown>,
  id: string,
): { mount: IslandMount; props: Record<string, unknown> } {
  const props = def.props === undefined ? rawProps : validateProps(def.props, rawProps).props;

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
      bind[prop] = { source: source.name, href: dataSourceHref(source.name) };
    }

    mount.bind = bind;
  }

  return { mount, props };
}
