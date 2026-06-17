/**
 * Compatibility re-export: the DeferredPanel island's canonical home moved to
 * `app/islands/deferred-panel.tsx` (ADR 0011 Increment 2 — the `app/islands/`
 * convention `@keel/assets` synthesizes the client entry from). The `/lab` page
 * keeps importing the named `DeferredPanel` through this shim.
 */

export { default as DeferredPanel } from "../../app/islands/deferred-panel";
