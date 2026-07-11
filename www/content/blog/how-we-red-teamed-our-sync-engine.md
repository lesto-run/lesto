---
title: How we red-teamed our sync engine
description: A sync engine that ships rows to the browser has one genuinely hard problem — per-row authorization. Here are four bugs adversarial review found before you would have, and why local-first is still v1, in hardening.
date: "2026-07-10"
author: The Lesto team
---

# How we red-teamed our sync engine

Lesto ships two ways to keep a browser in sync with the database, and they look similar until you notice what's on the wire. **Reactivity** ([ADR 0040](https://github.com/lesto-run/lesto/blob/main/docs/adr/0040-realtime-transport.md)) pushes a *topic* — a key string like `room:42`, never a row — and the client refetches through its own authorized read. **Local-first sync** ([ADR 0042](https://github.com/lesto-run/lesto/blob/main/docs/adr/0042-local-first-sync-tier-4.md)) is the other product: it ships the **rows themselves** to a durable store in the browser, so the app reads them locally and writes to them offline.

Shipping rows is where it gets hard. The moment row data is on the wire, the server has to answer one question for *every* changed row, forever: **may this client still see this?** That is per-row authorization, and it is the thing most likely to leak your users' data across a tenancy boundary. So before we called local-first anything, we red-teamed it — a two-lens review (red team plus chief architect) grounded in the actual code, then an adversarial multi-tenant acceptance matrix as the build-time gate. Four of the findings are worth telling, because each is the kind of bug that is invisible on the happy path and catastrophic in production.

## 1. The silent leak hiding in a Postgres default

To keep the client's local slice correct, the server has to detect when a row moves *out* of a shape — someone's `room_id` gets reassigned, and that row must be deleted from every client that could previously see it. Detecting that needs the row's **old** image: what did `room_id` used to be?

Here is the trap. Under Postgres's default replica identity, the logical replication stream carries only the **primary key** of the old tuple — not the old value of `room_id`. So a shape filtering on any non-key column (which is nearly every shape) cannot tell the row left. It doesn't error. The row simply **stays** in the client's durable store — a row the principal has lost access to, now leaked and persisted to disk on their device.

The fix is a hard requirement, not a suggestion: every table backing a shape must run `REPLICA IDENTITY FULL`, so the old row image is on the stream. And the shape engine **refuses to register a shape whose table can't supply that image** — it fails loudly at subscribe time rather than serving a shape that will silently leak. (A follow-up review sharpened it further: the same requirement covers a shape keyed on a *unique, non-primary* column like `slug` or `email`, where the default old-tuple-is-the-PK rule strands the old row the same way.) This was the single most important technical correction in the whole review, and it lives in one Postgres mechanic most people never think about.

## 2. A cursor that lies after failover

When a client reconnects, it says "I last saw change N; give me everything after." For that to be sound, "N" has to be an unambiguous position. Postgres gives you the commit **LSN**, which is perfect — until you remember an LSN is only meaningful within *one WAL timeline on one cluster*.

So a bare LSN is a **false continuity proof** across a failover or a restore. The client presents an LSN from the old database; the new one has a different WAL history at that position; the client "resumes" and silently misapplies — or misses — changes. The subtle part is that it takes *two* identities to catch every case, and they are not interchangeable: the **system id** (fixed at initdb) catches a pointer at a *different cluster*, but it is **constant across a same-cluster failover** — so on its own it misses the commonest case. The **timeline id** increments on every promotion, so it catches exactly that. The resume cursor therefore carries both, `(systemId, timelineId, LSN)`, and replay is allowed only when **both** match the live database; on any mismatch the client re-snapshots instead of replaying a lie.

We didn't trust that on a forged test alone. There's the forged-cursor cover in the per-PR gate, and there's a *real-mechanic* proof that stands up an actual primary plus a streaming-replication standby and `pg_promote`s it, so the timeline increments for real while the system id holds constant — and asserts a client with a pre-failover cursor re-snapshots. The branch fires on the failover the real world produces, not only the one a test hand-writes.

## 3. The fix that quietly reintroduced the bug

When the engine has to purge a diverged shape — a re-auth failure, a classification error, an identity change — it sends the client a `resync` frame: *your slice is gone, re-snapshot from scratch.* Correct in spirit. But the frame stamped its Server-Sent-Events `id:` field with the connection's last real cursor.

Read that again. The frame's body says "your slice is gone," and its `id:` says "you are perfectly LSN-continuous." So the browser's `EventSource`, doing what the spec tells it, reconnects with `Last-Event-ID` set to that real cursor — and the server dutifully **replays the missed changes onto the slice it just told the client to empty.** A resync that proves continuity. The result is a silent, durable divergence that is *strictly worse* than the leak the resync existed to fix.

The fix is the kind you want: make the bug unrepresentable. Every `resync` now carries a constant, non-resumable sentinel that decodes to "no cursor → re-snapshot from the floor," and `resync()` takes no cursor argument at all — so nobody can reintroduce the hole by passing the wrong value. The same latent bug was lurking on the backpressure-overflow path; it's closed by construction there too.

## 4. Dead on arrival in every browser

Everything above was green. The Postgres authorization matrix passed, the resume tests passed, CI was a wall of checkmarks. Then someone ran the capstone in an actual browser for the first time, and the durable store failed to open. In *every* browser.

OPFS-SQLite's storage backend needs `createSyncAccessHandle`, which the platform exposes **only inside a dedicated Worker** — in Chrome and Safari alike. We had booted the engine on the main thread, so the install rejected with "missing required OPFS APIs," nothing caught it, and every tab rendered no data. The Node-and-Postgres acceptance gate could never have caught this: Node has no OPFS, so its store legs ran over a different SQLite path and never touched the browser engine at all.

The code fix was to move the engine into a dedicated Worker and drive it over a `postMessage` RPC. The *process* fix mattered more, and we wrote it into our closure rule: **a deliverable whose runtime is browser-only cannot close on a Node gate alone — it needs at least one recorded real-browser run.** A green test suite is evidence about the thing the suite can reach, and nothing about the thing it can't.

## Why we're telling you the bugs

Because that's the honest version of "we built a sync engine." The hard part of local-first isn't the demo where two tabs update in real time — that part is easy and everyone's is impressive. The hard part is the adversary: the reassigned row that should have vanished from a device, the cursor that lies after a 3am failover, the resync that replays onto an emptied slice. We'd rather show our work on those than polish the demo.

That's also why local-first is **v1, in hardening** — not GA, and we won't call it that yet. Today it is single-table shapes with simple filters, last-write-wins conflict resolution, a browser-only durable store, and an operational footgun we're loud about (the shape engine taps one replication slot and must run as a single machine). What *is* true, precisely: local-first sync, v1 — Postgres logical replication to a durable local store, with offline writes. Shipped, gated end-to-end, and hardening in the open.

If you want to see it, the [`live-capstone`](https://github.com/lesto-run/lesto/tree/main/examples/live-capstone) example is the whole thing — a cross-tab, offline-capable app whose CI gate *is* the multi-tenant authorization matrix these findings came from. And the [local-first docs](/batteries/live) lay out the surface, the caveats, and where it goes next.
