import { describe, expect, it } from "vitest";

import {
  buildStandbyStatus,
  parseCopyDataFrame,
  PG_EPOCH_MS,
  XLOG_DATA_HEADER_BYTES,
} from "../src/replication-frames";

// ---------------------------------------------------------------------------
// The socket-free byte codecs for the Postgres streaming-replication copy-data stream, tested
// against EXACT bytes (like `pgoutput.test.ts` covers the decode side). These are the load-bearing
// halves of the coverage-excluded `pg-replication-client.ts`: the outbound Standby Status Update
// (`'r'`) whose correctness is the slot's disk-fill guard, and the inbound CopyData frame dispatch.
// Wire layouts hand-built from the PG streaming-replication protocol.
// ---------------------------------------------------------------------------

const hex = (s: string): Buffer => Buffer.from(s, "hex");
// An unsigned 64-bit int as its 8-byte big-endian hex (a WAL position / clock on the wire).
const u64 = (value: bigint): string => value.toString(16).padStart(16, "0");

describe("buildStandbyStatus — the outbound LSN-acknowledgement encoder", () => {
  it("lays out 'r' + received/flushed/applied LSN (thrice) + clock + reply byte, 34 bytes", () => {
    const lastLsn = 0x0000_0001_a563_a0ffn;
    const clockUs = 0x0000_02f8_900e_0b0fn;

    const status = buildStandbyStatus(lastLsn, clockUs);

    // 'r' (0x72) + lastLsn×3 (received, flushed, applied) + clockUs + replyRequested 0x00.
    const expected = `72${u64(lastLsn)}${u64(lastLsn)}${u64(lastLsn)}${u64(clockUs)}00`;
    expect(status.length).toBe(1 + 8 + 8 + 8 + 8 + 1);
    expect(status.toString("hex")).toBe(expected);

    // Field-level assertions so a shifted offset fails loudly, not just the whole-buffer compare.
    expect(status[0]).toBe(0x72); // 'r' — Standby Status Update
    expect(status.readBigUInt64BE(1)).toBe(lastLsn); // received
    expect(status.readBigUInt64BE(9)).toBe(lastLsn); // flushed
    expect(status.readBigUInt64BE(17)).toBe(lastLsn); // applied
    expect(status.readBigUInt64BE(25)).toBe(clockUs); // client clock
    expect(status[33]).toBe(0); // never requests an immediate reply
  });

  it("encodes a zero LSN (the pre-first-frame ack) as all-zero WAL positions", () => {
    const status = buildStandbyStatus(0n, 0n);

    // 'r' tag + three zero LSNs (24 B) + zero clock (8 B) + zero reply byte (1 B) = 33 zero bytes.
    expect(status.toString("hex")).toBe(`72${"00".repeat(33)}`);
  });

  it("PG_EPOCH_MS is the Unix→Postgres (2000-01-01) epoch offset in ms", () => {
    // 30 years of ms from 1970-01-01 to 2000-01-01 — the constant the client shifts Date.now() by.
    expect(PG_EPOCH_MS).toBe(BigInt(Date.UTC(2000, 0, 1)));
  });
});

describe("parseCopyDataFrame — the inbound CopyData tag dispatch", () => {
  it("dispatches a keepalive ('k') with walEnd and a set reply-requested flag", () => {
    const walEnd = 0x0000_0001_a563_d000n;
    // 'k' + Int64 walEnd + Int64 time + Byte replyRequested(1)
    const frame = hex(`6b${u64(walEnd)}${u64(0x02f8_900e_0b0fn)}01`);

    expect(parseCopyDataFrame(frame)).toEqual({
      kind: "keepalive",
      walEnd,
      replyRequested: true,
    });
  });

  it("dispatches a keepalive with the reply-requested flag CLEAR (the common no-ack path)", () => {
    const walEnd = 0x0000_0001_a563_d000n;
    const frame = hex(`6b${u64(walEnd)}${u64(0x02f8_900e_0b0fn)}00`); // replyRequested 0x00

    expect(parseCopyDataFrame(frame)).toEqual({
      kind: "keepalive",
      walEnd,
      replyRequested: false,
    });
  });

  it("dispatches an XLogData ('w') to its walStart + the bare pgoutput payload (25-byte header stripped)", () => {
    const walStart = 0x0000_0001_a563_a0ffn;
    const payloadHex = "420000000001a563a00002f8900e0b0ff0000002f2"; // a real Begin message
    // 'w' + Int64 walStart + Int64 walEnd + Int64 time + payload
    const frame = hex(`77${u64(walStart)}${u64(walStart)}${u64(0x02f8_900e_0b0fn)}${payloadHex}`);

    const result = parseCopyDataFrame(frame);

    expect(result.kind).toBe("xlog");
    if (result.kind !== "xlog") throw new Error("unreachable");
    expect(result.walStart).toBe(walStart);
    expect(result.payload.toString("hex")).toBe(payloadHex);
    // The payload begins exactly after the fixed XLogData header.
    expect(frame.length - result.payload.length).toBe(XLOG_DATA_HEADER_BYTES);
  });

  it("classifies an unknown tag byte as 'other' (e.g. a CopyDone 'c') — nothing to apply", () => {
    expect(parseCopyDataFrame(hex("63deadbeef"))).toEqual({ kind: "other" });
  });

  it("classifies an empty frame as 'other' (no leading byte to read)", () => {
    expect(parseCopyDataFrame(Buffer.alloc(0))).toEqual({ kind: "other" });
  });
});
