/**
 * The durable, OFFLINE-CAPABLE `live()` round-trip, end to end (ADR 0042 Tier 4, v1 Inc5/Inc6):
 *
 *   openOpfsSqliteDatabase()  ->  createSqliteLiveStore({ def, db })  ->  createLiveQuery(def, { store })
 *                                                              \->  createLiveMutations({ store, submit })
 *
 * `openOpfsSqliteDatabase` boots `@sqlite.org/sqlite-wasm` over OPFS (the peer this bundle exists to
 * prove wires correctly — see `packages/live/src/opfs-sqlite.ts`). `createSqliteLiveStore` wraps it
 * in the durable `LiveStore` (rows + resume cursor persisted atomically), and — new in Inc6 — a
 * durable outbox. `createLiveMutations` is that outbox: a write is applied to the store
 * OPTIMISTICALLY (shown at once, even offline) and durably logged, then replayed on reconnect as the
 * app's NORMAL authorized `POST /notes` — the same endpoint an online write hits, no bespoke sync
 * channel. A server-rejected write rolls back locally.
 *
 * Two payoffs to see by hand:
 *   1. Durable first paint — on reload `render()` paints whatever the store hydrated from OPFS
 *      before the network reconnects.
 *   2. Offline writes — go offline (DevTools → Network → Offline), add a note (it appears instantly
 *      and is durably logged to the OPFS outbox), then go back online and watch it drain to the server
 *      and reconcile as the authoritative row under the same id. (A reload while FULLY offline can't
 *      re-fetch the app shell — no service worker ships here — so the reload-survival of a pending
 *      write is a durable-store property, demonstrable once the shell is reachable.)
 */

import { createLiveMutations, createLiveQuery, createSqliteLiveStore } from "@lesto/live";
import type { MutationOutcome } from "@lesto/live";
import { openOpfsSqliteDatabase } from "@lesto/live/opfs";

import { notesShape } from "./schema";

// Extends `Row` (`Record<string, unknown>`) rather than just declaring these fields, so it
// satisfies `createLiveQuery`'s `R extends Row` bound while still giving `.text` etc. a real
// type at the call sites below. `id` is the client-generated uuid (see `schema.ts`).
interface NoteRow extends Record<string, unknown> {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly createdAt: number;
}

/**
 * Replay one queued write as the app's authorized `POST /notes`, classifying the result the way
 * the outbox needs (ADR 0042 Inc6): a 2xx is `"ok"` (accepted — the echo carries the truth), a 4xx
 * is `"rejected"` (the server refused it — roll back), and a thrown/`fetch` failure or a 5xx is
 * `"retry"` (offline / transient — keep it queued and try again on reconnect).
 */
async function postNote(_name: string, input: unknown): Promise<MutationOutcome> {
  let response: Response;

  try {
    response = await fetch("/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    return "retry"; // the network never answered — the ordinary offline case
  }

  if (response.ok) return "ok";

  // 4xx → the server refused this write; replaying it would only be refused again. 5xx → transient.
  return response.status >= 400 && response.status < 500 ? "rejected" : "retry";
}

async function main(): Promise<void> {
  const list = document.querySelector<HTMLUListElement>("#notes");
  const form = document.querySelector<HTMLFormElement>("#add-form");
  const input = document.querySelector<HTMLInputElement>("#note-text");
  const status = document.querySelector<HTMLParagraphElement>("#status");

  if (list === null || form === null || input === null || status === null) return;

  const setStatus = (message: string): void => {
    status.textContent = message;
  };

  setStatus("Opening durable OPFS-SQLite store...");

  const { db } = await openOpfsSqliteDatabase();

  const store = await createSqliteLiveStore({
    def: notesShape,
    db,
    onError: (error) => setStatus(`Durable write failed (mirror stays correct): ${String(error)}`),
  });

  const query = createLiveQuery<NoteRow>(notesShape, {
    onError: () => setStatus("Stream hiccup — resyncing..."),
    store,
  });

  // The offline-write outbox over the SAME durable store: it rehydrates any writes made offline in
  // a prior session (re-showing them) and replays every pending write through `postNote` on drain.
  const mutations = createLiveMutations({
    store,
    submit: postNote,
    onError: (error) => setStatus(`Replay error (write kept, will retry): ${String(error)}`),
  });

  const render = (): void => {
    list.replaceChildren(
      ...query.getSnapshot().map((note) => {
        const item = document.createElement("li");

        item.textContent = note.text;

        return item;
      }),
    );
  };

  // Paint immediately from whatever the durable store hydrated — the authorized slice AND any
  // offline writes the outbox just re-applied — before the live stream below has reconnected.
  render();
  setStatus(
    `Ready — ${query.getSnapshot().length} note(s) loaded (${mutations.pending()} pending).`,
  );
  query.subscribe(render);

  // Drain now (an offline write from a prior session may be waiting) and on every reconnect.
  void mutations.flush();
  window.addEventListener("online", () => void mutations.flush());

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const text = input.value.trim();

    if (text === "") return;

    input.value = "";

    // The client mints the row id — the correlation key the server's echo settles under. Submit
    // applies it optimistically (shown at once, even offline), durably logs it, and tries to drain.
    const id = globalThis.crypto.randomUUID();

    mutations.submit({
      name: "notes",
      input: { id, text },
      optimistic: {
        op: "insert",
        key: id,
        row: { id, text, done: false, createdAt: Date.now() },
      },
    });
  });
}

void main().catch((error: unknown) => {
  const status = document.querySelector<HTMLParagraphElement>("#status");

  if (status !== null) {
    status.textContent = `Could not open the durable store: ${String(error)}`;
  }
});
