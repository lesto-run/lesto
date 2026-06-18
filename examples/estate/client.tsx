/**
 * The browser entry — what `<script src="/client.js">` loads.
 *
 * It builds a registry holding the page's island declarations and calls
 * `hydrateDocumentIslands`, which scans the document for the co-located
 * `data-volo-island-mount` scripts `defineIsland` emitted, then finds each marked
 * shell and mounts the real client component.
 *
 * This is the CANONICAL synthesized shape (ADR 0011 Increment 2): one client
 * entry point that registers exactly the islands declared under `app/islands/`
 * (one `defineIsland` default-export per file) and hands them to
 * `hydrateDocumentIslands`. It is what `@volo/assets`' `synthesizeEntry` would
 * generate from the same `app/islands/` convention — estate keeps it checked in
 * (its bespoke worker path bundles this file directly) so the source is
 * inspectable, but its content matches the framework's synthesized entry byte for
 * byte in shape: import the defaults, `.defineClient(Island.island)`, hydrate.
 *
 * Bundle this to `/client.js`; until then the pages degrade gracefully to their
 * fallbacks.
 */

import { Registry } from "@volo/ui";
import { hydrateDocumentIslands } from "@volo/ui/client";
import { startBrowserRum } from "@volo/observability/rum";

import AccountIsland from "./app/islands/account";
import LiveListing from "./app/islands/live-listing";
import DeferredPanel from "./app/islands/deferred-panel";

// Each island's declaration (carried on `.island`) is what the client registers,
// so the browser mounts the very components the server reserved slots for:
// Account (eager, server-resolved data), LiveListing (client-fetched via
// @volo/client), and DeferredPanel (hydrated only when scrolled into view).
const registry = new Registry()
  .defineClient(AccountIsland.island)
  .defineClient(LiveListing.island)
  .defineClient(DeferredPanel.island);

hydrateDocumentIslands(registry);

// Browser RUM (ARCHITECTURE.md §7): read the SSR-injected `volo-traceparent` meta,
// adopt the server trace id, and POST navigation/resource/web-vital spans under it
// to `/__volo/browser-spans` — so a page load's browser spans stitch to the server
// `http.request` span. This is the canonical synthesized-entry shape: the same
// `startBrowserRum()` call `@volo/assets` emits, checked in here for inspection.
startBrowserRum();
