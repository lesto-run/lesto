/**
 * The two date dialects a feed must speak.
 *
 * RSS 2.0 dates are RFC 822 (the `<pubDate>`/`<lastBuildDate>` format, e.g.
 * `Mon, 08 Jun 2026 00:00:00 GMT`); Atom 1.0 dates are RFC 3339 (the
 * `<updated>` format, e.g. `2026-06-08T00:00:00Z`). A caller may hand us either
 * a `Date` — which we format — or a string they have already formatted, which
 * we trust and pass through untouched. Both helpers always emit UTC.
 */

import { FeedError } from "./errors";

/** A date a caller may supply as a `Date` or a pre-formatted string. */
export type DateInput = Date | string;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Reject the one `Date` we can never format: an invalid one. */
function assertValid(date: Date): void {
  if (Number.isNaN(date.getTime())) {
    throw new FeedError("FEED_INVALID_DATE", "Feed dates must be valid Date instances.", {
      value: date,
    });
  }
}

/** A string passes through; a `Date` is formatted by `format`. */
function formatInput(value: DateInput, format: (date: Date) => string): string {
  if (typeof value === "string") return value;

  assertValid(value);

  return format(value);
}

/** Format a `Date` as an RFC 822 (RSS) UTC timestamp; pass a string through. */
export function rfc822(value: DateInput): string {
  return formatInput(value, (date) => {
    const day = DAYS[date.getUTCDay()];
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const month = MONTHS[date.getUTCMonth()];
    const yyyy = date.getUTCFullYear();
    const hh = String(date.getUTCHours()).padStart(2, "0");
    const mm = String(date.getUTCMinutes()).padStart(2, "0");
    const ss = String(date.getUTCSeconds()).padStart(2, "0");

    return `${day}, ${dd} ${month} ${yyyy} ${hh}:${mm}:${ss} GMT`;
  });
}

/** Format a `Date` as an RFC 3339 (Atom) UTC timestamp; pass a string through. */
export function rfc3339(value: DateInput): string {
  return formatInput(value, (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z"));
}
