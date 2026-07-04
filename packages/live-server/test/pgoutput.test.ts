import { describe, expect, it } from "vitest";

import { LiveServerError } from "../src/errors";
import { createPgOutputDecoder } from "../src/pgoutput";

// ---------------------------------------------------------------------------
// The fixtures below are REAL pgoutput messages captured off a live Postgres logical-replication
// slot (debezium/postgres:16, proto v1, a `messages(id serial pk, room_id int, body text)` table
// under REPLICA IDENTITY FULL) — the XLogData header stripped, so each is a bare pgoutput message.
// Captured 2026-07-01 during the Inc1 live-PG shakeout (L-4b7edd48). See scratchpad/capture.mjs.
// ---------------------------------------------------------------------------

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));
// Build a pgoutput frame from hex parts (array-joined, not `+`-concatenated string literals).
const frame = (...parts: string[]): Uint8Array => hex(parts.join(""));
// A UTF-8 string as its NUL-terminated hex (a column/table name on the wire).
const cstr = (s: string): string => `${Buffer.from(s).toString("hex")}00`;
// A text ('t') tuple column: kind 't' + Int32 length + the value's hex.
const textCol = (s: string): string => {
  const value = Buffer.from(s).toString("hex");
  return `74${(value.length / 2).toString(16).padStart(8, "0")}${value}`;
};

const BEGIN = hex("420000000001a563a00002f8900e0b0ff0000002f2");
const RELATION = hex(
  "52000040107075626c6963006d65737361676573006600030169640000000017ffffffff01726f6f6d5f69640000000017ffffffff01626f64790000000019ffffffff",
);
const INSERT = hex("49000040104e000374000000013174000000023432740000000568656c6c6f");
const UPDATE = hex(
  "55000040104f000374000000013174000000023432740000000568656c6c6f4e000374000000013174000000023939740000000568656c6c6f",
);
const DELETE = hex("44000040104f000374000000013174000000023939740000000568656c6c6f");
const COMMIT = hex("43000000000001a563a00000000001a563d00002f8900e0b0ff0");

// Invoke `fn`, assert it threw a `LiveServerError`, and return that error's code.
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LiveServerError);
    return (error as LiveServerError).code;
  }
  throw new Error("expected a throw, got none");
};

describe("createPgOutputDecoder — real captured frames", () => {
  it("Begin stamps the transaction commit LSN; Relation + control frames yield no change", () => {
    const decoder = createPgOutputDecoder();

    expect(decoder.decode(BEGIN)).toBeUndefined();
    expect(decoder.decode(RELATION)).toBeUndefined();
    expect(decoder.decode(COMMIT)).toBeUndefined();
  });

  it("decodes an insert to newImage-only, stamped with the Begin's commit LSN, values TEXT-encoded", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(BEGIN);
    decoder.decode(RELATION);

    expect(decoder.decode(INSERT)).toEqual({
      op: "insert",
      table: "messages",
      commitLSN: "0/1A563A0", // Begin.finalLSN, formatted HI/LO upper-hex
      newImage: { id: "1", room_id: "42", body: "hello" }, // pgoutput proto v1 → text values
    });
  });

  it("decodes an update to both images (old present under REPLICA IDENTITY FULL)", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(BEGIN);
    decoder.decode(RELATION);

    expect(decoder.decode(UPDATE)).toEqual({
      op: "update",
      table: "messages",
      commitLSN: "0/1A563A0",
      oldImage: { id: "1", room_id: "42", body: "hello" },
      oldImageKind: "full", // an 'O' tuple under REPLICA IDENTITY FULL
      newImage: { id: "1", room_id: "99", body: "hello" },
    });
  });

  it("decodes a delete to oldImage-only, marked full ('O' under REPLICA IDENTITY FULL)", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(BEGIN);
    decoder.decode(RELATION);

    expect(decoder.decode(DELETE)).toEqual({
      op: "delete",
      table: "messages",
      commitLSN: "0/1A563A0",
      oldImage: { id: "1", room_id: "99", body: "hello" },
      oldImageKind: "full",
    });
  });

  it("accepts a Buffer directly (the real client passes a Buffer subarray, not a plain Uint8Array)", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(Buffer.from(RELATION)); // Buffer.isBuffer(message) === true path

    expect(decoder.decode(Buffer.from(INSERT))).toMatchObject({ op: "insert", table: "messages" });
  });

  it("refuses a change for a relation whose Relation message was never seen (protocol violation)", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(BEGIN); // no Relation

    expect(() => decoder.decode(INSERT)).toThrow(LiveServerError);
    try {
      decoder.decode(INSERT);
    } catch (error) {
      expect((error as LiveServerError).code).toBe("LIVE_SERVER_REPLICATION_UNKNOWN_RELATION");
    }
  });
});

describe("createPgOutputDecoder — synthesized tuple kinds (null / unchanged-TOAST / key-only)", () => {
  // A Relation for `t(a,b)`, OID 100: 'R' + oid + "public\0" + "t\0" + replica-id 'd' + 2 cols.
  const rel = (): Uint8Array =>
    frame(
      "52", // 'R'
      "00000064", // oid 100
      cstr("public"),
      cstr("t"),
      "64", // 'd' default replica identity
      "0002", // 2 columns
      `01${cstr("a")}00000017ffffffff`,
      `00${cstr("b")}00000019ffffffff`,
    );

  it("maps 'n' to null and 'u' (unchanged TOAST) to undefined", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(rel());

    // Insert into oid 100: 'I' + oid + 'N' + tuple[ a='n'(null), b='u'(unchanged) ]
    const insert = frame("49", "00000064", "4e", "0002", "6e", "75");

    expect(decoder.decode(insert)).toEqual({
      op: "insert",
      table: "t",
      commitLSN: "0/0", // no Begin seen → the initial cursor
      newImage: { a: null, b: undefined },
    });
  });

  it("handles an update with a key-only ('K') old tuple under the default replica identity", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(rel());

    // 'U' + oid + 'K' + old[ a='t'"1", b='n' ] + 'N' + new[ a='t'"2", b='t'"x" ]
    const update = frame(
      "55",
      "00000064",
      "4b", // 'K'
      "0002",
      textCol("1"),
      "6e", // b is null in the key image
      "4e", // 'N'
      "0002",
      textCol("2"),
      textCol("x"),
    );

    expect(decoder.decode(update)).toEqual({
      op: "update",
      table: "t",
      commitLSN: "0/0",
      oldImage: { a: "1", b: null }, // b's 'n' → a null value, NOT distinguishable from a real null…
      oldImageKind: "key", // …which is exactly why the 'K' MARKER, not the value, is what's trusted
      newImage: { a: "2", b: "x" },
    });
  });

  it("handles an update with NO old tuple (default replica identity, unchanged key) — oldImage empty, marked 'none'", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(rel());

    // 'U' + oid + 'N' + new[ a='t'"2", b='t'"x" ]  (no 'K'/'O' before 'N')
    const update = frame("55", "00000064", "4e", "0002", textCol("2"), textCol("x"));

    expect(decoder.decode(update)).toEqual({
      op: "update",
      table: "t",
      commitLSN: "0/0",
      oldImage: {},
      oldImageKind: "none",
      newImage: { a: "2", b: "x" },
    });
  });

  it("marks a delete's old tuple 'key' when it is key-only ('K' under DEFAULT — the downgrade DELETE leak the marker catches)", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(rel());

    // 'D' + oid + 'K' + old[ a='t'"1" (the key), b='n' (a nulled non-identity column) ]
    const del = frame("44", "00000064", "4b" /* 'K' */, "0002", textCol("1"), "6e" /* b = 'n' */);

    expect(decoder.decode(del)).toEqual({
      op: "delete",
      table: "t",
      commitLSN: "0/0",
      oldImage: { a: "1", b: null }, // b reads null by value — the marker is the only sound signal
      oldImageKind: "key",
    });
  });
});

describe("createPgOutputDecoder — malformed / truncated frames (defense-in-depth on the DB wire)", () => {
  // A minimal Relation for `t(a)`, OID 100, so a change can resolve its columns.
  const rel = (): Uint8Array =>
    frame(
      "52",
      "00000064",
      cstr("public"),
      cstr("t"),
      "64",
      "0001",
      `01${cstr("a")}00000017ffffffff`,
    );

  it("(a) refuses a C string with no NUL terminator instead of silently rewinding the cursor", () => {
    const decoder = createPgOutputDecoder();
    // 'R' + oid + "public" WITHOUT its trailing NUL — cstring's indexOf(0) finds none.
    const truncated = frame("52", "00000064", Buffer.from("public").toString("hex"));

    expect(codeOf(() => decoder.decode(truncated))).toBe("LIVE_SERVER_REPLICATION_MALFORMED_FRAME");
  });

  it("(b) refuses a tuple column whose length prefix overruns the frame instead of clamping the subarray", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(rel());

    // 'I' + oid + 'N' + 1 col + 't' + length 0x000000ff (255) but only 2 bytes supplied.
    const insert = frame("49", "00000064", "4e", "0001", "74", "000000ff", "3132");

    expect(codeOf(() => decoder.decode(insert))).toBe("LIVE_SERVER_REPLICATION_MALFORMED_FRAME");
  });

  it("(c) refuses an Update whose post-OID marker is neither 'O'/'K'/'N' instead of assuming 'N'", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(rel());

    // 'U' + oid + 0x58 ('X') — not an old-tuple 'O'/'K', and not the new-tuple 'N'.
    const update = frame("55", "00000064", "58");

    expect(codeOf(() => decoder.decode(update))).toBe("LIVE_SERVER_REPLICATION_MALFORMED_FRAME");
  });

  it("(d) refuses an Insert whose post-OID marker is not the new-tuple 'N' instead of decoding garbage", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(rel());

    // 'I' + oid + 0x58 ('X') — not the new-tuple 'N' that always precedes an Insert's TupleData.
    const insert = frame("49", "00000064", "58");

    expect(codeOf(() => decoder.decode(insert))).toBe("LIVE_SERVER_REPLICATION_MALFORMED_FRAME");
  });

  it("(e) refuses a Delete whose old-tuple marker is neither 'O' nor 'K' instead of assuming 'key'", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(rel());

    // 'D' + oid + 0x58 ('X') — not an old-tuple 'O'/'K'; the old fall-through decoded it as 'key'.
    const del = frame("44", "00000064", "58");

    expect(codeOf(() => decoder.decode(del))).toBe("LIVE_SERVER_REPLICATION_MALFORMED_FRAME");
  });

  it("(f) refuses a tuple whose length PREFIX is cut mid-Int32 (coded, not a bare RangeError)", () => {
    const decoder = createPgOutputDecoder();
    decoder.decode(rel());

    // 'I' + oid + 'N' + 1 col + kind 't' + only 2 of the length prefix's 4 bytes — the Int32 read
    // for the length runs past the frame's end, so #need codes it (vs. readUInt32BE's RangeError).
    const insert = frame("49", "00000064", "4e", "0001", "74", "0000");

    expect(codeOf(() => decoder.decode(insert))).toBe("LIVE_SERVER_REPLICATION_MALFORMED_FRAME");
  });
});
