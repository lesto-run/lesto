/**
 * The Server-Sent Events wire codec (ADR 0040) — the pure string layer between the
 * `(topic, cursor)` model and the bytes an `EventSource` reads.
 *
 * The wire carries an invalidation **topic** and a **resume cursor**, never row
 * data (the ADR 0027 invariant). Each frame is one SSE event:
 *
 *   - `invalidate` — a topic the client should drop and refetch through its
 *     authorized read; its `id:` is the resume cursor, echoed back as
 *     `Last-Event-ID` on reconnect.
 *   - `resync` — "refetch everything you subscribe to", the always-correct floor
 *     when continuity cannot be proven; it still carries the current cursor so the
 *     client resumes precise replay from *now* after reconciling.
 *   - a `: comment` — the heartbeat that holds the stream open through intermediary
 *     idle timeouts and detects a dead peer.
 *
 * Everything here is pure over its inputs and 100%-tested; the socket that emits
 * these strings is the coverage-excluded wiring.
 */

import type { Cursor } from "./replay-ring";

/**
 * Encode a {@link Cursor} into the single-line token the SSE `id:` field carries.
 *
 * Format: `<instanceId>.<generation>.<index>`. The `instanceId` is a boot-minted
 * id with no dots (a UUID), so the three fields never collide; {@link decodeCursor}
 * nonetheless parses from the right so an `instanceId` that *did* contain a dot
 * still round-trips. The `id:` field forbids a newline, and none of the three
 * fields can hold one.
 */
export function encodeCursor(cursor: Cursor): string {
  return `${cursor.instanceId}.${cursor.generation}.${cursor.index}`;
}

/**
 * Decode a `Last-Event-ID` token back into a {@link Cursor}, or `undefined` when it
 * is malformed.
 *
 * A malformed or absent cursor is not an error — it forces a coarse `resync`, the
 * safe floor. Parsed from the right (`index`, then `generation`, then the rest as
 * `instanceId`) so a dot inside the `instanceId` is preserved. `generation` and
 * `index` must be non-negative integers and `instanceId` non-empty, or the whole
 * token is rejected: a hostile or truncated value can never be mistaken for a
 * valid position.
 */
export function decodeCursor(token: string | undefined): Cursor | undefined {
  if (token === undefined) return undefined;

  const parts = token.split(".");

  // Need an instanceId part plus generation and index.
  if (parts.length < 3) return undefined;

  const index = Number(parts.pop());
  const generation = Number(parts.pop());
  const instanceId = parts.join(".");

  if (instanceId === "") return undefined;
  if (!isNonNegativeInt(generation)) return undefined;
  if (!isNonNegativeInt(index)) return undefined;

  return { instanceId, generation, index };
}

/** A finite, non-negative integer — the shape `generation`/`index` must take. */
function isNonNegativeInt(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * An `invalidate` frame: the topic to drop, with the resume cursor as its `id:`.
 *
 * The client maps this to `QueryClient.invalidateTopic(topic)` (the wire carries a
 * *topic*, not a query key). The trailing blank line terminates the SSE event.
 */
export function invalidateFrame(topic: string, cursor: string): string {
  return `event: invalidate\ndata: ${topic}\nid: ${cursor}\n\n`;
}

/**
 * A `resync` frame: "refetch everything you subscribe to". It carries the current
 * cursor as its `id:` so that, having reconciled, the client resumes precise
 * replay from *now* rather than re-resyncing on its next blip.
 */
export function resyncFrame(cursor: string): string {
  return `event: resync\ndata: \nid: ${cursor}\n\n`;
}

/**
 * A comment frame — the heartbeat. SSE comments (`:`-prefixed) are ignored by
 * `EventSource` but keep the connection from idling out at an intermediary (e.g.
 * Cloudflare's ~100s) and surface a dead peer to the writer.
 */
export function commentFrame(text: string): string {
  return `: ${text}\n\n`;
}

/**
 * Parse the requested-topics query value into a clean, deduped list.
 *
 * Topics arrive comma-separated (`?topics=org:1:posts,org:1:comments`). Blanks and
 * surrounding whitespace are dropped, and duplicates collapse — the same topic
 * subscribed twice is one subscription. An absent or all-blank value yields `[]`.
 */
export function parseTopics(raw: string | undefined): string[] {
  if (raw === undefined) return [];

  const seen = new Set<string>();
  const topics: string[] = [];

  for (const part of raw.split(",")) {
    const topic = part.trim();

    if (topic === "") continue;
    if (seen.has(topic)) continue;

    seen.add(topic);
    topics.push(topic);
  }

  return topics;
}
