/**
 * The docs search box — the site's one interactive island, now a ⌘K palette.
 *
 * This is pure dogfooding: the entire palette (the `⌘K` / `Ctrl K` shortcut, the
 * modal, keyboard navigation, ARIA wiring, and the keyword ranking) is the
 * framework's own {@link CommandPalette} from `@lesto/content-search/react`. The
 * site contributes nothing but the slot — exactly the bar we hold ourselves to:
 * anything we'd hand-roll for the docs should be a feature of the content
 * packages instead.
 *
 * It stays a DEFERRED island (`ssr: false`): the server renders the static
 * {@link SearchFallback} trigger, and the preact client mounts the real palette
 * fresh on load. On open the palette fetches the prerendered `/search-index.json`
 * and runs `keywordSearch` over it entirely in the browser — no server, no model.
 */

import { CommandPalette } from "@lesto/content-search/react";
import { defineIsland } from "@lesto/ui";
import type { ReactElement } from "react";

function SearchBox(): ReactElement {
  return <CommandPalette indexPath="/search-index.json" triggerLabel="Search" />;
}

/**
 * The server-rendered placeholder: a static, disabled trigger that matches the
 * palette's own button so nothing shifts when the client mounts the real one.
 * (The `⌘K` hint is corrected to `Ctrl K` on non-Mac once the client takes over.)
 */
function SearchFallback(): ReactElement {
  return (
    <button className="lesto-cmdk-trigger" type="button" disabled aria-label="Search">
      <span className="lesto-cmdk-trigger-icon" aria-hidden="true">
        ⌕
      </span>
      <span className="lesto-cmdk-trigger-label">Search</span>
      <kbd className="lesto-cmdk-kbd">⌘K</kbd>
    </button>
  );
}

export default defineIsland({
  name: "Search",
  component: SearchBox,
  fallback: SearchFallback,
});
