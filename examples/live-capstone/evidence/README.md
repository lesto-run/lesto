# Capstone browser-checklist evidence (`L-aa9779f5`)

The recorded real-browser execution of [`../README.md`](../README.md)'s **manual browser
checklist** — the epic-closure evidence the Tier-4 v1 capstone ratification (`L-b1501de9`, fork A)
required for the browser-only half the sandbox + the bun/PG acceptance gate cannot execute (OPFS
durable first paint, offline-write optimistic + durable-log, cross-tab leader/follower + failover).

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

### 1. Durable first paint  →  `01-message-sent.png`, `04-durable-paint-server-blocked.png`, `durability-network-proof.json`

- Sent `"hello from alice — durable OPFS proof"`; it painted in the list (`01`).
- **What "first paint" actually looks like (honest):** on reload the very first `render()` runs
  against a *fresh empty* in-memory store (the durable rows haven't loaded yet — the OPFS worker must
  boot + the ~940 KB wasm compile + hydrate), so there is a brief empty frame, then the durable rows
  paint one async hop later. This is always **before the SSE stream connects** — by construction, the
  leader opens the stream only after the store attaches (`cross-tab.ts`), not by winning a race. The
  `— 0 message(s)` count in every post-reload screenshot is that empty init-time snapshot; the **list**
  is authoritative.
- **Source isolation (the real proof):** reloaded online **but with both server data routes aborted at
  the network layer** (`route.abort()` on `/__lesto/live-data**` and `/messages**`). All **3 durable
  rows still painted**, while the SSE subscription failed with `net::ERR_FAILED` — captured in
  [`durability-network-proof.json`](./durability-network-proof.json) (the aborted-request record is the
  load-bearing artifact; a screenshot of a reload looks identical whether or not the wire was blocked).
  Screenshot `04` shows the 3 rows under that blocked condition. With the wire provably unreachable and
  a single tab + no service worker (see premises in the JSON), OPFS is the only possible source.

### 2. Offline writes  →  `03-offline-write-optimistic.png`

- Emulated offline (`context.setOffline(true)`), sent `"offline write by alice — queued in the
  outbox"`. It painted **at once** (leader optimistic overlay) while the `POST /messages` failed —
  the expected single console error (`03`).
- On reconnect, the outbox **drained**: after the network returned, `GET /messages` from the shell
  showed the offline row had reconciled onto the server (verified again end-to-end in step 3's write).
- **Not demonstrated in-browser here:** *reload-survival of a pending offline write*. A fully-offline
  `page.reload()` fails at the document fetch (no service worker ships the app shell — boundary #1),
  so this run could not reload with a still-pending write. That property (a pending write re-queues, a
  held write rebuilds as held) is proven by the acceptance gate's check 8a/8b — over **Node SQLite**,
  not the OPFS engine — and awaits the filed browser smoke `L-2e410682` for a browser proof.

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
   README's original "go offline, reload" step depends on the browser's HTTP disk cache serving the
   shell, which this static server doesn't guarantee (the checklist was corrected to not claim it). The
   **data** durability is unaffected and is proven in step 1 by blocking only the data routes while
   letting the shell load online. A PWA shell-cache is the natural follow-up if true offline cold-start
   is wanted.
2. **The empty first frame is real, not just a cosmetic count.** The `— 0 message(s)` status is
   computed once at init from `query.getSnapshot().length` **before** the async leader store attaches —
   and the first `render()` also runs against that same empty snapshot, so the list's *first* paint is
   empty too; the durable rows are the **second** paint (a tick later, after the OPFS worker boots).
   The count is not hiding data loss (the list ends correct), but it honestly witnesses that "durable
   first paint" is "durable *second* paint, after an empty frame" — always still before the stream
   connects. A synchronous durable hydrate (or a "loading…" placeholder like `live-durable` uses) would
   remove the empty frame.
3. **A benign sqlite-wasm warning appears on every load** (`console-full.log`): *"Ignoring inability to
   install OPFS sqlite3_vfs: … Missing SharedArrayBuffer and/or Atomics … COOP/COEP …"*. This is
   sqlite-wasm's init probing the **plain** SharedArrayBuffer-based `opfs` VFS, which we deliberately do
   **not** use — the durable store runs on the **SAHPool** VFS, which needs no COOP/COEP headers and
   installed fine (the 80 KB persisted above is the proof). Expected, not a failure; it is precisely
   why SAHPool-in-a-Worker was chosen over the header-gated alternatives.

## Artifact provenance (what is a file vs. a live observation)

Honest accounting so a future reader knows what to trust:

- **File-backed:** the 7 screenshots, [`durability-network-proof.json`](./durability-network-proof.json)
  (the aborted-route + rendered-rows capture — the load-bearing durability artifact), and
  `console-full.log`.
- **`console-full.log` is the FINAL page's console dump** (the bonus authz page), NOT the whole run —
  it holds the two benign sqlite-wasm warnings + bob's deliberate 403. So "0 console errors" in step 0
  describes that step as observed live, not this file.
- **Live-only observations** (seen in the Playwright tool output at capture time, not saved as separate
  files): the step-0 OPFS byte probe ("6 pooled files / ~80 KB"), and the step-3 follower "opened no
  `/__lesto/live-data` of its own" network check. The filed browser smoke `L-2e410682` is what turns
  these into repeatable CI assertions.

## The automated regression gate this run motivated

A manual run is confirmation, not a gate — nothing stops the main-thread regression from returning.
`L-2e410682` is therefore promoted from deferred polish to the **headless-browser smoke gate** that
boots the real `openOpfsSqliteDatabase`, writes a row, reloads, and asserts durable repaint — the
test that would have caught the Inc9 class in CI. This evidence closes the *visual* guarantee; that
gate closes the *regression* guarantee.
