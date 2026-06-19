/**
 * The `/lab` data + mutation contracts — shared by import between the server route
 * and the `@lesto/client` islands that call them (no codegen, no GraphQL).
 *
 * The server's `.get("/lab/api/listings/:id")` answers with a `Listing`; the
 * `LiveListing` island declares `LabApi` so `api.get(...)` is typed to the exact
 * same `Listing` shape. Drift is impossible: both reference one type.
 *
 * The mutation half (ADR 0022) is the typed-RPC counterpart: `saveListingNote` is
 * defined ONCE server-side (`lab.tsx`), and its argument + return types flow to the
 * `SaveNote` island's call site via `MutationContractOf<typeof labMutations>` — the
 * same contract-typing trick, applied to a state-changing mutation.
 */

import type { Listing } from "./listings";

export interface LabApi {
  "GET /lab/api/listings/:id": { response: Listing };
  /** Mints a fresh double-submit CSRF token for the demo's anon session (ADR 0022). */
  "GET /lab/api/csrf": { response: { token: string } };
}
