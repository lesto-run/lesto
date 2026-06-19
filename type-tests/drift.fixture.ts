/**
 * The acceptance proof: a DELIBERATE type drift, kept commented out.
 *
 * Uncommenting the block below introduces a wrong type expectation that MUST make
 * `tsc -p type-tests/tsconfig.json` go red — demonstrating the suite actually
 * catches a regression rather than passing vacuously. Re-commenting it makes the
 * suite green again. (Run the proof:
 *
 *     bunx tsc -p type-tests/tsconfig.json   # green
 *     # …uncomment the block…
 *     bunx tsc -p type-tests/tsconfig.json   # RED — TS2344 on `Expect<...>`
 *     # …re-comment the block…
 *     bunx tsc -p type-tests/tsconfig.json   # green again
 *
 * The drift asserts that `InferRow<typeof users>.id` is a `string` when it is in
 * fact a `number`. `Equal` resolves to `false`, and `Expect<false>` fails its
 * `extends true` constraint with TS2344 — the suite's whole job, proven.)
 *
 * KEEP THIS BLOCK COMMENTED on `main`. It exists as the documented, runnable proof
 * that the gate has teeth, not as a live test.
 */

export {};

/*
import { defineTable, integer, text } from "@lesto/db";
import type { InferRow } from "@lesto/db";

import type { Equal, Expect } from "./assert";

const driftTable = defineTable("drift", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

// WRONG ON PURPOSE: `id` is a `number`, not a `string`. `Equal` is `false`, so
// `Expect<false>` fails with TS2344 — proving the gate detects drift.
type _intentionalDrift = Expect<Equal<InferRow<typeof driftTable>, { id: string; name: string }>>;
*/
