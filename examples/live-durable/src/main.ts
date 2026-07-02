/**
 * The durable `live()` round-trip, end to end (ADR 0042 Tier 4, v1 Inc5/Inc6 dogfood):
 *
 *   openOpfsSqliteDatabase()  ->  createSqliteLiveStore({ def, db })  ->  createLiveQuery(def, { store })
 *
 * `openOpfsSqliteDatabase` boots `@sqlite.org/sqlite-wasm` over OPFS (the peer this bundle
 * exists to prove wires correctly — see the module doc on `packages/live/src/opfs-sqlite.ts`
 * and this example's `README.md`). `createSqliteLiveStore` wraps that connection in the
 * durable `LiveStore` — every mutation mirrors in memory AND persists rows + the resume
 * cursor atomically. `createLiveQuery` opens the `GET /__lesto/live-data` subscription
 * against it, so a peer's write (via the form below, `POST /notes`) streams in live.
 *
 * The durability payoff is the FIRST paint: on a reload, `render()` below paints whatever
 * `createSqliteLiveStore` hydrated from the OPFS-persisted slice — before the network
 * reconnects. A non-durable (in-memory) store would paint nothing until the first snapshot.
 */

import { createLiveQuery, createSqliteLiveStore, openOpfsSqliteDatabase } from "@lesto/live";

import { notesShape } from "./schema";

// Extends `Row` (`Record<string, unknown>`) rather than just declaring these fields, so it
// satisfies `createLiveQuery`'s `R extends Row` bound while still giving `.text` etc. a real
// type at the call sites below.
interface NoteRow extends Record<string, unknown> {
  readonly id: number;
  readonly text: string;
  readonly done: boolean;
  readonly createdAt: number;
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

  const render = (): void => {
    list.replaceChildren(
      ...query.getSnapshot().map((note) => {
        const item = document.createElement("li");

        item.textContent = note.text;

        return item;
      }),
    );
  };

  // Paint immediately from whatever the durable store hydrated (a prior session's persisted
  // slice survives reload) — before the live stream below has reconnected.
  render();
  setStatus(`Ready — ${query.getSnapshot().length} note(s) loaded from the durable store.`);
  query.subscribe(render);

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const text = input.value.trim();

    if (text === "") return;

    input.value = "";

    void fetch("/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch((error: unknown) => setStatus(`Could not reach the server: ${String(error)}`));
  });
}

void main().catch((error: unknown) => {
  const status = document.querySelector<HTMLParagraphElement>("#status");

  if (status !== null) {
    status.textContent = `Could not open the durable store: ${String(error)}`;
  }
});
