import type { Clock } from "./types";

/**
 * Time, made injectable.
 *
 * ISO-8601 strings sort lexicographically in the same order they occur in time,
 * so we can compare deadlines in plain SQL (`locked_until < :now`) with no date
 * math in the database.
 */

export const systemClock: Clock = () => new Date();

export const nowIso = (clock: Clock): string => clock().toISOString();

export const isoAfter = (clock: Clock, ms: number): string =>
  new Date(clock().getTime() + ms).toISOString();
