/**
 * Marshal a JS value into the form a SQL driver accepts as a bound `?` parameter.
 *
 * Shared by BOTH value paths — INSERT/UPDATE payloads (`queries.ts`) and
 * WHERE-condition operands (`conditions.ts`) — so the two can never disagree on
 * how a type is bound. They used to be separate copies, and a `Date` branch added
 * to one but not the other made `gte(col, date)` throw while `insert({ col: date })`
 * worked; one function removes that whole class of bug.
 *
 *   - `undefined` → `null` (a missing insert value is SQL NULL; conditions are
 *     `NonNullable` so they never hit this, but it's harmless and consistent)
 *   - `boolean`   → `1` / `0` (the `INTEGER` storage of a `boolean` column)
 *   - `Date`      → epoch-ms `number` (the `INTEGER` storage of a `timestamp` column)
 *   - everything else passes through on its `?` placeholder
 */
export function bind(value: unknown): unknown {
  if (value === undefined) return null;

  if (typeof value === "boolean") return value ? 1 : 0;

  if (value instanceof Date) return value.getTime();

  return value;
}
