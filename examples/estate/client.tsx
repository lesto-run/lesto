/**
 * The browser entry — what `<script src="/client.js">` loads.
 *
 * It builds a registry holding the page's island declarations and calls
 * `hydrateDocumentIslands`, which scans the document for the co-located
 * `data-lesto-island-mount` scripts `defineIsland` emitted, then finds each marked
 * shell and mounts the real client component.
 *
 * This follows the CANONICAL synthesized shape (ADR 0011 Increment 2): one client
 * entry point that registers island `defineIsland` default-exports and hands them
 * to `hydrateDocumentIslands`, the same shape `@lesto/assets`' `synthesizeEntry`
 * emits. estate keeps it checked in because its bespoke PRODUCTION worker path
 * bundles this file directly (as Preact) and the source is inspectable.
 *
 * It is NOT identical to the framework's synthesized entry, though — it is the
 * hand-curated PRODUCTION client: it registers only the three deferred (`ssr: false`)
 * islands the Preact-compat alias can safely hydrate (so `save-note`, server-rendered
 * under Preact, is deliberately omitted) and it adds `enableSoftNav` below. Local
 * `lesto dev` does NOT use this file — it synthesizes its own React entry over all of
 * `app/islands/` — so dev and prod are not byte-for-byte equivalent yet (see README
 * Notes). Bundle this to `/client.js`; until then the pages degrade to their fallbacks.
 */

import { Registry } from "@lesto/ui";
import { enableSoftNav, hydrateDocumentIslands } from "@lesto/ui/client";
import { startBrowserRum } from "@lesto/observability/rum";

import AccountIsland from "./app/islands/account";
import LiveListing from "./app/islands/live-listing";
import DeferredPanel from "./app/islands/deferred-panel";

// Each island's declaration (carried on `.island`) is what the client registers,
// so the browser mounts the very components the server reserved slots for:
// Account (eager, server-resolved data), LiveListing (client-fetched via
// @lesto/client), and DeferredPanel (hydrated only when scrolled into view).
const registry = new Registry()
  .defineClient(AccountIsland.island)
  .defineClient(LiveListing.island)
  .defineClient(DeferredPanel.island);

hydrateDocumentIslands(registry);

// Client-side soft navigation (ADR 0024): upgrade in-app `<Link>` clicks to a
// fetch-and-swap over the SAME registry, so a swapped-in page's islands re-hydrate
// with these exact components. A `<Link>` is a real `<a>`, so with no JS (or before
// this loads) every link still does an ordinary navigation — soft nav is a pure
// enhancement. The file-routed gallery (`/lab/gallery`, ADR 0023) is the visible
// proof: clicking a listing swaps in its detail page without a full reload.
enableSoftNav(registry);

// Browser RUM (ARCHITECTURE.md §7): read the SSR-injected `lesto-traceparent` meta,
// adopt the server trace id, and POST navigation/resource/web-vital spans under it
// to `/__lesto/browser-spans` — so a page load's browser spans stitch to the server
// `http.request` span. This is the canonical synthesized-entry shape: the same
// `startBrowserRum()` call `@lesto/assets` emits, checked in here for inspection.
startBrowserRum();
