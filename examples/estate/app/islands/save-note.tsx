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
 *     typed to the server's Zod input, and `result.data.saved` to its return.
 *   - the typed error path: a non-2xx is the `{ ok: false, error }` arm, never a
 *     throw — typing a note of `boom` shows the server's `LAB_NOTE_REJECTED` code.
 *   - CSRF: the double-submit token is read back from `GET /lab/api/csrf` and sent
 *     on `x-csrf-token`, so the boundary's reused `verifyToken` check passes.
 *   - boundary validation: an empty note is refused server-side (`MUTATION_INVALID_INPUT`).
 *
 * Default-exported (one island per file) so `@lesto/assets` synthesizes its client
 * registration — no hand-written `client.tsx`.
 */

import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { defineIsland } from "@lesto/ui";
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

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; note: string; savedAt: string }
  | { status: "error"; code: string; message: string };

/** The mounted island: a one-field form that calls the typed mutation on submit. */
function SaveNoteView({ listingId }: { listingId: string }): ReactNode {
  const [note, setNote] = useState("");
  const [state, setState] = useState<SaveState>({ status: "idle" });
  const [csrf, setCsrf] = useState<string | undefined>(undefined);

  // Read the double-submit token back from the cookie's companion route — the page
  // half of the pattern. A real per-user app reads it from the companion cookie.
  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const { token } = await api.get("/lab/api/csrf");

        if (active) setCsrf(token);
      } catch {
        // Leave csrf undefined; a submit then takes the typed CSRF-failure path.
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setState({ status: "saving" });

    // The typed mutation client, threading the CSRF token onto every call.
    const mutate = createMutationClient<LabMutations>({
      ...trace,
      ...(csrf === undefined ? {} : { csrfToken: csrf }),
    });

    const result = await mutate.saveListingNote({ listingId, note });

    // The discriminated result union: one `if`, a typed error path, no try/catch.
    if (result.ok) {
      setState({
        status: "saved",
        note: result.data.saved.note,
        savedAt: result.data.saved.savedAt,
      });
    } else {
      setState({ status: "error", code: result.error.code, message: result.error.message });
    }
  }

  return (
    <form className="card" onSubmit={(e) => void onSubmit(e)}>
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
        <button type="submit" disabled={state.status === "saving"}>
          {state.status === "saving" ? "Saving…" : "Save note (typed mutation)"}
        </button>
      </p>

      {state.status === "saved" && (
        <p className="copy">
          Saved: “{state.note}” at {state.savedAt}.
        </p>
      )}

      {state.status === "error" && (
        <p className="copy">
          Rejected ({state.code}): {state.message}
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
