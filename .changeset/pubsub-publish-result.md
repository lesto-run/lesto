---
"@lesto/pubsub": minor
---

`publish()` now resolves to a `PublishResult` (`{ delivered, failed }`) instead of a bare `number`, so one throwing/rejecting listener no longer determines the shape of the whole call — it's isolated and reported in `failed` while `delivered` still reflects everyone who settled cleanly. This mirrors the isolation `fanout()` already guarantees for sockets (F17, L-a2dc1535).

- **`@lesto/pubsub`**: `publish(channel, message): Promise<PublishResult>` replaces `Promise<number>`. `PublishResult` is `{ delivered: number; failed: readonly unknown[] }` — `failed` collects the errors thrown/rejected by individual listeners, in delivery order; a channel with no subscribers still yields `{ delivered: 0, failed: [] }`. **Migration:** anywhere reading the old return value directly (`const notified = await hub.publish(...)`), read `result.delivered` instead (`const { delivered } = await hub.publish(...)`); destructure `failed` too if you want visibility into which listeners broke.
- Both in-repo consumers (`packages/realtime/src/bus.ts`, the ws fan-out layer) already `void` the return value, so this is not an in-repo behavior change — but it is a public breaking API change for any external consumer reading the old bare count.

Bump level: `minor` — the repo is pre-1.0 (0.x) and treats minor as the breaking-change channel under lockstep versioning (see the reserved-0.2.0 note in `edge-pbkdf2-iteration-cap.md`); `major` stays held for the eventual 1.0 launch.
