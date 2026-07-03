/**
 * The Tier-4 v1 capstone browser client (ADR 0042 Inc8) — the durable, offline-capable,
 * cross-tab-coordinated `live()` view, auth-scoped to a `?user=` / `?room=`:
 *
 *   createCrossTabLiveQuery(def, { createLeaderStore })   // one leader syncs; the rest mirror
 *        \-> createLeaderStore: openOpfsSqliteDatabase() -> createSqliteLiveStore()   // durable, per-leader
 *                                                       \-> createLiveMutations()      // offline outbox
 *
 * Why cross-tab is not optional here: the durable store is OPFS-SQLite over the SyncAccessHandle Pool
 * VFS, which takes an EXCLUSIVE per-origin handle — a second tab that opened it directly would throw.
 * So `createCrossTabLiveQuery` elects ONE leader tab to hold the connection + the durable store, and
 * relays its rendered slice to followers over BroadcastChannel; leadership fails over on tab close.
 * That is what makes "open the app in five tabs" work at all (Inc7).
 *
 * Three things to see by hand (the README's manual checklist — the one piece this repo's sandbox
 * cannot execute; the acceptance gate proves the server/wire half over the real Postgres path):
 *   1. **Durable first paint** — reload and the leader repaints from OPFS before the stream reconnects.
 *   2. **Offline writes** — go offline, send a message (shown at once, survives reload via the outbox),
 *      go online, watch it drain to the authorized `POST /messages` and reconcile under its client id.
 *   3. **Cross-tab** — open a second tab (a follower mirrors the leader with no connection of its own);
 *      close the leader and the follower is promoted and resumes the stream.
 *
 * **Known boundary (`L-f5a4f807`, a filed child of this capstone):** the offline outbox lives on the
 * LEADER's store, because only the leader holds the durable store + connection and Inc7 relays reads
 * leader→followers, not writes follower→leader. So a FOLLOWER tab's send takes the plain authorized
 * `POST` path (no local optimistic overlay); it still appears everywhere via the leader's echo, just
 * without a follower-local instant paint. Write-relay + failover-orphan handling is that follow-up.
 */

import { createCrossTabLiveQuery, createLiveMutations, createSqliteLiveStore } from "@lesto/live";
import type { LeaderStore, LiveMutations, MutationOutcome } from "@lesto/live";
import { openOpfsSqliteDatabase } from "@lesto/live/opfs";

import { messagesInRoom } from "./schema";

/** One synced row, typed for the render below. `id` is the client-minted uuid (the correlation key). */
interface MessageRow extends Record<string, unknown> {
  readonly id: string;
  readonly roomId: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: number;
}

/** Read the auth scope from the URL — a session cookie in production, a query for this demo. */
function scope(): { user: string; room: string } {
  const params = new URLSearchParams(globalThis.location.search);

  return { user: params.get("user") ?? "alice", room: params.get("room") ?? "lobby" };
}

/**
 * Replay one queued write as the app's authorized `POST /messages`, classified the way the outbox
 * needs (ADR 0042 Inc6): a 2xx is `"ok"` (the echo carries the truth), a 4xx is `"rejected"` (the
 * server refused it — roll back), a thrown `fetch`/5xx is `"retry"` (offline / transient — keep it).
 */
async function postMessage(user: string, _name: string, input: unknown): Promise<MutationOutcome> {
  let response: Response;

  try {
    response = await fetch(`/messages?user=${encodeURIComponent(user)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    return "retry"; // the network never answered — the ordinary offline case
  }

  if (response.ok) return "ok";

  return response.status >= 400 && response.status < 500 ? "rejected" : "retry";
}

async function main(): Promise<void> {
  const list = document.querySelector<HTMLUListElement>("#messages");
  const form = document.querySelector<HTMLFormElement>("#send-form");
  const input = document.querySelector<HTMLInputElement>("#message-body");
  const status = document.querySelector<HTMLParagraphElement>("#status");

  if (list === null || form === null || input === null || status === null) return;

  const { user, room } = scope();
  const def = messagesInRoom(room);

  const setStatus = (message: string): void => {
    status.textContent = `${user} @ ${room} — ${message}`;
  };

  // The offline outbox lives on the LEADER's durable store (see the module doc). It is (re)built each
  // time this tab wins leadership, and cleared when the term ends, so only the tab that actually holds
  // the durable store + connection applies optimistic writes.
  let leaderMutations: LiveMutations | undefined;

  const createLeaderStore = async (): Promise<LeaderStore> => {
    const { db } = await openOpfsSqliteDatabase();

    const store = await createSqliteLiveStore({
      def,
      db,
      onError: (error) =>
        setStatus(`durable write failed (mirror stays correct): ${String(error)}`),
    });

    // The outbox over the SAME durable store: it rehydrates any writes made offline in a prior
    // session and replays every pending write through the authorized `POST` on drain.
    const mutations = createLiveMutations({
      store,
      submit: (name, payload) => postMessage(user, name, payload),
      onError: (error) => setStatus(`replay error (write kept, will retry): ${String(error)}`),
    });

    leaderMutations = mutations;
    void mutations.flush(); // drain any offline write left from a prior session

    return {
      store,
      dispose: async () => {
        await store.whenIdle();
        leaderMutations = undefined;
      },
    };
  };

  const query = createCrossTabLiveQuery<MessageRow>(def, {
    createLeaderStore,
    onError: (error) => setStatus(`stream/leadership error: ${String(error)}`),
  });

  const render = (): void => {
    list.replaceChildren(
      ...query.getSnapshot().map((message) => {
        const item = document.createElement("li");

        item.textContent = `${message.author}: ${message.body}`;

        return item;
      }),
    );
  };

  render();
  setStatus(`ready — ${query.getSnapshot().length} message(s)`);
  query.subscribe(render);

  // Drain the leader's outbox on every reconnect (an offline write may be waiting).
  globalThis.addEventListener("online", () => void leaderMutations?.flush());

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const body = input.value.trim();

    if (body === "") return;

    input.value = "";

    // The client mints the row id — the correlation key the server's echo settles under.
    const id = globalThis.crypto.randomUUID();

    if (leaderMutations !== undefined) {
      // Leader: apply optimistically (shown at once, even offline), durably log, and try to drain.
      leaderMutations.submit({
        name: "messages",
        input: { id, room, body },
        optimistic: {
          op: "insert",
          key: id,
          row: { id, roomId: room, author: user, body, createdAt: Date.now() },
        },
      });

      return;
    }

    // Follower: no local durable store to write through, so take the plain authorized `POST` path.
    // A follower send is NOT queued — online it lands everywhere via the leader's echo (no
    // follower-local instant paint), but offline / on a 4xx it FAILS NOW, so surface that rather than
    // silently drop the text (the `L-f5a4f807` boundary documented above; a real app would relay the
    // write to the leader's outbox).
    void (async () => {
      const outcome = await postMessage(user, "messages", { id, room, body });

      if (outcome !== "ok") {
        setStatus(
          `follower send ${outcome} — not queued (offline sends need the leader tab): "${body}"`,
        );
      }
    })();
  });
}

void main().catch((error: unknown) => {
  const status = document.querySelector<HTMLParagraphElement>("#status");

  if (status !== null) status.textContent = `Could not start the capstone client: ${String(error)}`;
});
