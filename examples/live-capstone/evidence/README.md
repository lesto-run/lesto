# Capstone browser-checklist evidence (`L-aa9779f5`)

The recorded real-browser execution of [`../README.md`](../README.md)'s **manual browser
checklist** — the epic-closure evidence the Tier-4 v1 capstone ratification (`L-b1501de9`, fork A)
required for the browser-only half the sandbox + the bun/PG acceptance gate cannot execute (OPFS
durable first paint, offline-write-survives, cross-tab leader/follower + failover).

- **When:** 2026-07-03 (UTC), against `main`.
- **How:** a real headed **Chromium 149** driven over the Playwright MCP (the same "real browser or
  a playwright-MCP agent" the task authorises; mirrors the 0033 in-preview-AI dogfood pattern).
- **App under test:** `examples/live-capstone`, built with `bun run build` and served with `bun run
  serve` on the **dev SQLite-poll source** (`LESTO_LIVE_SOURCE` unset). The three checklist steps all
  live *above* the change source, so the poll path exercises them exactly as prod would — the PG
  replication half is the automated gate's job (`test/acceptance.pg.ts`), not the browser's.

> ## ⚠️ This run first found a P0 — the checklist never actually passed before Inc9
>
> The very first real-browser load failed hard: `OpfsSqliteError: Could not open OPFS-SQLite`,
> cause `Error: Missing required OPFS APIs.` The durable OPFS store — the whole point of the tier —
> had **never opened in any browser**. Root cause: `@lesto/live`'s `openOpfsSqliteDatabase` booted
> `sqlite3-wasm` + `installOpfsSAHPoolVfs` **on the main thread**, but SAHPool requires
> `FileSystemFileHandle.prototype.createSyncAccessHandle`, which is `[Exposed=DedicatedWorker]` —
> Worker-only in **Chrome and Safari alike**. Since `OpfsSqliteError` was caught nowhere, *every*
> tab failed leadership → the capstone was DOA in a browser. The Node/bun acceptance gate can't
> catch this (no OPFS in Node). This reopened the epic; the fix (**Inc9**, `L-565a4b33`) moves the
> engine into a dedicated Worker (`packages/live/src/opfs-worker.ts`) driven over a request-correlated
> RPC (`opfs-rpc.ts`), leaving the store layer untouched. **The evidence below is the post-Inc9 run.**

## The checklist, as executed

Each step lists what was driven, what was observed, and the screenshot under `screenshots/`.
Server-side cross-checks were issued with `curl` from the shell, which reaches the server directly
even when the browser's network is emulated offline — used to *isolate the data's source*.

### 0. Clean boot — the fix works

Loaded `?user=alice&room=lobby`. Status: **`alice @ lobby — ready — 0 message(s)`**, **0 console
errors** (contrast: the pre-Inc9 load showed the `OpfsSqliteError`). A worker-side OPFS probe
confirmed the SAHPool opened and persisted real bytes (6 pooled files / ~80 KB).

### 1. Durable first paint  →  `01-message-sent.png`, `04-durable-paint-server-blocked.png`

- Sent `"hello from alice — durable OPFS proof"`; it painted in the list immediately (`01`).
- **Airtight source isolation:** reloaded with the browser online **but every server data route
  blocked** at the network layer (`route.abort()` on `/__lesto/live-data**` and `/messages**`), so
  the app shell loads but no row can arrive over the wire. The message **still painted** from the
  durable store (`04`). With the server data stream provably unreachable, OPFS is the only possible
  source — this is the durable-first-paint guarantee, proven rather than asserted.

### 2. Offline writes  →  `03-offline-write-optimistic.png`

- Emulated offline (`context.setOffline(true)`), sent `"offline write by alice — queued in the
  outbox"`. It painted **at once** (leader optimistic overlay) while the `POST /messages` failed —
  the expected single console error (`03`).
- On reconnect, the outbox **drained**: after the network returned, `GET /messages` from the shell
  showed the offline row had reconciled onto the server (verified again end-to-end in step 3's write).

### 3. Cross-tab leader / follower + failover  →  `05-follower-mirrors-leader.png`, `06-follower-promoted-after-failover.png`

- Opened a **second tab** on the same `?room=lobby`. It mirrored the leader's full list with **0
  errors** and — verified via the network panel — **opened no `/__lesto/live-data` connection of its
  own** (`05`). It reads leader→follower over BroadcastChannel; it never contended for the exclusive
  OPFS handle (which is exactly why a second tab doesn't throw).
- **Failover:** closed the leader tab. The surviving follower was **promoted** (0 errors — it
  successfully re-opened the now-released exclusive OPFS handle as the new leader), then a send of
  `"after failover — this tab was promoted to leader"` painted optimistically **and** reached the
  server (`curl` showed all 3 rows) — i.e. the promoted tab resumed the connection + outbox, not just
  the local view (`06`).

### Bonus — parameter shape-authz refusal  →  `07-authz-refused-bob-engineering.png`

Not one of the three checklist steps, but browser-observable and central to the tier: loaded
`?user=bob&room=engineering` (bob is not a member). The `/__lesto/live-data` **shape subscription was
refused with 403** (console), the list stayed empty, and the shell cross-check confirmed **403 for
bob vs 200 for alice** on the same room — parameter-level authz refusing before any stream opens, not
a broken room.

## Honest boundaries observed (not defects in the data path)

1. **A fully-offline *reload* can't re-fetch the app shell.** This example ships no service worker, so
   `page.reload()` while offline fails at the *document* fetch (`ERR_INTERNET_DISCONNECTED`) — the
   README's "go offline, reload" step depends on the browser's HTTP disk cache serving the shell,
   which this static server doesn't guarantee. The **data** durability is unaffected and is proven
   airtight in step 1 by blocking only the data routes while letting the shell load. A PWA
   shell-cache is the natural follow-up if true offline cold-start is wanted.
2. **The status line's `— N message(s)` count is a snapshot-timing artifact.** It is computed once at
   init from `query.getSnapshot().length` before the async leader store has attached, so it can read
   `0` while the list itself then repaints the durable rows. Cosmetic (the list is correct); noted so
   a future reader doesn't mistake it for data loss.
3. **A benign sqlite-wasm warning appears on every load** (`console-full.log`): *"Ignoring inability to
   install OPFS sqlite3_vfs: … Missing SharedArrayBuffer and/or Atomics … COOP/COEP …"*. This is
   sqlite-wasm's init probing the **plain** SharedArrayBuffer-based `opfs` VFS, which we deliberately do
   **not** use — the durable store runs on the **SAHPool** VFS, which needs no COOP/COEP headers and
   installed fine (the 80 KB persisted above is the proof). Expected, not a failure; it is precisely
   why SAHPool-in-a-Worker was chosen over the header-gated alternatives.

## The automated regression gate this run motivated

A manual run is confirmation, not a gate — nothing stops the main-thread regression from returning.
`L-2e410682` is therefore promoted from deferred polish to the **headless-browser smoke gate** that
boots the real `openOpfsSqliteDatabase`, writes a row, reloads, and asserts durable repaint — the
test that would have caught the Inc9 class in CI. This evidence closes the *visual* guarantee; that
gate closes the *regression* guarantee.
