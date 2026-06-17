/**
 * Compatibility re-export: the LiveListing island's canonical home moved to
 * `app/islands/live-listing.tsx` (ADR 0011 Increment 2 — the `app/islands/`
 * convention `@keel/assets` synthesizes the client entry from). The `/lab` page
 * keeps importing the named `LiveListing` through this shim.
 */

export { default as LiveListing } from "../../app/islands/live-listing";
