/**
 * The `/lab` data API contract — shared by import between the server route and
 * the `@keel/client` island that calls it (no codegen, no GraphQL).
 *
 * The server's `.get("/lab/api/listings/:id")` answers with a `Listing`; the
 * `LiveListing` island declares this contract so `api.get(...)` is typed to the
 * exact same `Listing` shape. Drift is impossible: both reference one type.
 */

import type { Listing } from "./listings";

export interface LabApi {
  "GET /lab/api/listings/:id": { response: Listing };
}
