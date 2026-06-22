/**
 * `SaveNote` — the TYPED-MUTATION island (ADR 0022), as a canonical `app/islands/`
 * module.
 *
 * The write-side counterpart to `LiveListing`'s typed read: where that island GETs
 * a listing through the typed `@lesto/client`, this one calls the `saveListingNote`
 * SERVER MUTATION — defined once in `src/lab.tsx`, called here with its argument +
 * return types inferred end to end via `MutationContractOf<typeof labMutations>`.
 * No codegen, no RSC transform; just a typed POST to one CSRF-guarded endpoint.
 *
 * It demonstrates, on one form:
 *   - end-to-end inferred types: `mutate.saveListingNote({ listingId, note })` is
 *     typed to the server's Zod input, and the result's `saved` to its return.
 *   - the typed error path: a non-2xx is the `{ ok: false, error }` arm, never a
 *     throw — typing a note of `boom` shows the server's `LAB_NOTE_REJECTED` code.
 *   - `@lesto/ui`'s `useMutation` owning the pending/result state — no hand-rolled
 *     `useState` saving machine; the discriminated result union IS `save.data`.
 *   - the INTERNALIZED CSRF round-trip: the mutation client fetches the double-submit
 *     token itself once (lazily, cached) via `fetchCsrfToken`, so this form no longer
 *     reads `GET /lab/api/csrf` in a `useEffect`, holds it in state, and rebuilds the
 *     client per submit — the round-trip lives in the client, not the component.
 *
 * Default-exported (one island per file) so `@lesto/assets` synthesizes its client
 * registration — no hand-written `client.tsx`.
 */

import { useState } from "react";
import type { ReactNode } from "react";

import { defineIsland, useMutation } from "@lesto/ui";
import { createApi, createMutationClient } from "@lesto/client";
import { readTraceparentMeta } from "@lesto/observability/rum";

import type { LabApi } from "../../src/lab-api";
import type { labMutations } from "../../src/lab";

// The contract type flows from the SERVER mutation map's `typeof` — the single
// source of truth (no codegen). Only the TYPE crosses; the server module's values
// never enter the browser bundle (`import type`).
import type { MutationContractOf } from "@lesto/runtime";

type LabMutations = MutationContractOf<typeof labMutations>;

// Same-origin clients; the page trace (ARCHITECTURE.md §7) joins the CSR call to the
// page's trace when the SSR meta is present, exactly as LiveListing does.
const pageTrace = readTraceparentMeta();
const trace = pageTrace === undefined ? {} : { trace: { traceId: pageTrace.traceId } };

const api = createApi<LabApi>(trace);

// One mutation client for the island's lifetime, with the CSRF round-trip
// INTERNALIZED: `fetchCsrfToken` runs once (lazily, then cached) on the first
// submit that needs a token — replacing the per-submit `GET /lab/api/csrf` +
// `useState`/`useEffect` + client-rebuild the form used to hand-roll.
const mutate = createMutationClient<LabMutations>({
  ...trace,
  fetchCsrfToken: () => api.get("/lab/api/csrf").then((r) => r.token),
});

/** The mounted island: a one-field form that calls the typed mutation on submit. */
function SaveNoteView({ listingId }: { listingId: string }): ReactNode {
  const [note, setNote] = useState("");

  // useMutation owns `{ isPending, data }`; the mutation's discriminated
  // `{ ok, … }` union becomes `save.data` directly — one branch, no try/catch.
  const save = useMutation((input: { listingId: string; note: string }) =>
    mutate.saveListingNote(input),
  );

  const result = save.data;

  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void save.mutate({ listingId, note });
      }}
    >
      <label className="copy" htmlFor="note">
        Note for {listingId}
      </label>

      <input
        id="note"
        name="note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="A quiet, motivated seller… (type 'boom' to see the typed error path)"
      />

      <p className="copy">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save note (typed mutation)"}
        </button>
      </p>

      {result?.ok && (
        <p className="copy">
          Saved: “{result.data.saved.note}” at {result.data.saved.savedAt}.
        </p>
      )}

      {result !== undefined && !result.ok && (
        <p className="copy">
          Rejected ({result.error.code}): {result.error.message}
        </p>
      )}
    </form>
  );
}

export default defineIsland({
  name: "SaveNote",
  component: SaveNoteView,
  fallback: () => <p className="copy">Loading the note form…</p>,
});
