/**
 * Compatibility re-export: the SaveNote island's canonical home is
 * `app/islands/save-note.tsx` (ADR 0011 Increment 2 — the `app/islands/`
 * convention `@lesto/assets` synthesizes the client entry from). The `/lab` page
 * keeps importing the named `SaveNote` through this shim.
 */

export { default as SaveNote } from "../../app/islands/save-note";
