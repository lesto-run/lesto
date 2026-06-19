/**
 * Type-regression fixtures for `@lesto/db`'s schema-as-value inference.
 *
 * What this pins (the differentiator: ONE schema value drives the row, insert,
 * and update types with no codegen):
 *
 *   - `InferRow`    — SELECT's row shape, with per-column nullability folded in.
 *   - `InferInsert` — INSERT's accepted shape: required keys required, and
 *                     nullable / defaulted / auto-increment keys OPTIONAL.
 *   - `InferUpdate` — UPDATE `.set(...)`'s shape: every column optional, no auto
 *                     fields dropped.
 *   - column-kind → JS type mapping (text→string, integer/real→number,
 *     boolean→boolean, timestamp→Date), and that nullability widens to `| null`.
 *   - the anti-ORM win: `eq(column, value)` rejects a value of the wrong type.
 *
 * If any of these regress (a field widens to `unknown`, a required insert key
 * silently becomes optional, the timestamp column stops hydrating to `Date`),
 * `tsc -p type-tests/tsconfig.json` goes red here — the runtime tests would not.
 */

import { boolean, defineTable, eq, integer, real, text, timestamp } from "@lesto/db";
import type { InferInsert, InferRow, InferUpdate } from "@lesto/db";

import type { Equal, Expect, Resolve } from "./assert";

// A schema value with one column of every relevant shape: an auto-increment
// primary key (optional on insert), a required text, a DEFAULTED-BUT-NULLABLE
// integer, a nullable text (widened to `| null`), and the two kinds whose JS type
// diverges from their storage type — boolean and timestamp.
//
// `loginCount` is intentionally `.default(0)` WITHOUT `.notNull()`: a default does
// not imply NOT NULL, so the column stays nullable and its row/insert/update type
// stays `number | null`. Pinning this guards a tempting "a column with a default is
// non-null" mis-refactor — which would silently narrow the type and crash a reader
// expecting `null` to be possible.
const users = defineTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  loginCount: integer("login_count").default(0),
  nickname: text("nickname"),
  isAdmin: boolean("is_admin").notNull(),
  createdAt: timestamp("created_at").notNull(),
});

// ── InferRow: every column present, nullability folded in ───────────────────────

// The row a SELECT yields. `id`/`email`/`loginCount` are NOT NULL or have a value,
// `nickname` is nullable so it widens to `string | null`, `isAdmin` hydrates to a
// JS `boolean` and `createdAt` to a JS `Date` (both stored as INTEGER) — the kind
// dispatch the query layer performs, pinned at the type level.
type UserRow = Resolve<InferRow<typeof users>>;

type _row = Expect<
  Equal<
    UserRow,
    {
      id: number;
      email: string;
      loginCount: number | null;
      nickname: string | null;
      isAdmin: boolean;
      createdAt: Date;
    }
  >
>;

// ── InferInsert: required keys required, optional keys optional ──────────────────

// On INSERT only `email`, `isAdmin`, and `createdAt` are mandatory: `id` is
// auto-increment, `loginCount` has a default, `nickname` is nullable, so those are
// OPTIONAL. The optionality is the contract `db.insert(...)` enforces — getting it
// wrong (a required column made optional) is a runtime crash the types must catch.
// `Resolve` flattens `InferInsert`'s `{required} & {optional?}` intersection into a
// single literal so `Equal`'s identity check holds (the intersection and its flat
// form are mutually assignable but not *identical*). The flatten widens nothing.
type UserInsert = Resolve<InferInsert<typeof users>>;

type _insert = Expect<
  Equal<
    UserInsert,
    {
      email: string;
      isAdmin: boolean;
      createdAt: Date;
      id?: number;
      loginCount?: number | null;
      nickname?: string | null;
    }
  >
>;

// ── InferUpdate: every column optional, none dropped ────────────────────────────

// `.set(...)` accepts any subset of columns — all optional, including the auto
// `id` (the query layer, not the type, forbids touching the key). The nullable
// column keeps its `| null`.
type UserUpdate = Resolve<InferUpdate<typeof users>>;

type _update = Expect<
  Equal<
    UserUpdate,
    {
      id?: number;
      email?: string;
      loginCount?: number | null;
      nickname?: string | null;
      isAdmin?: boolean;
      createdAt?: Date;
    }
  >
>;

// ── Column-kind → JS type mapping, in isolation ─────────────────────────────────

const kinds = defineTable("kinds", {
  t: text("t").notNull(),
  i: integer("i").notNull(),
  r: real("r").notNull(),
  b: boolean("b").notNull(),
  ts: timestamp("ts").notNull(),
});

type _kindMap = Expect<
  Equal<Resolve<InferRow<typeof kinds>>, { t: string; i: number; r: number; b: boolean; ts: Date }>
>;

// ── The anti-ORM win: a wrong-typed comparison is a compile error ───────────────

// `eq(users.email, ...)` binds against a `string` column. A number is rejected.
// This is the whole point of the typed column reference — caught at compile time,
// not as a silent SQL mismatch at runtime.
eq(users.email, "ada@example.com"); // ok — types line up

// @ts-expect-error — `email` is a string column; a number value must not type-check.
eq(users.email, 1);

// @ts-expect-error — `loginCount` is a number column; a string value must not type-check.
eq(users.loginCount, "many");

eq(users.isAdmin, true); // ok — boolean column, boolean value

// @ts-expect-error — `isAdmin` is a boolean column; a string value must not type-check.
eq(users.isAdmin, "yes");

// ── Insert requiredness, enforced through the public `InferInsert` ──────────────

// A complete object assigns; an object missing a required key does not.
const completeInsert: UserInsert = {
  email: "ada@example.com",
  isAdmin: false,
  createdAt: new Date(),
};
void completeInsert;

// @ts-expect-error — `email` is required on insert; omitting it must not type-check.
const missingEmail: UserInsert = { isAdmin: false, createdAt: new Date() };
void missingEmail;

// @ts-expect-error — `isAdmin` (NOT NULL, no default) is required; omitting it must not type-check.
const missingFlag: UserInsert = { email: "ada@example.com", createdAt: new Date() };
void missingFlag;

// An optional key may be omitted entirely — the auto / defaulted / nullable columns.
const minimalInsert: UserInsert = {
  email: "grace@example.com",
  isAdmin: true,
  createdAt: new Date(),
};
void minimalInsert;
