/**
 * Unit coverage for the slot-lag classifier (`L-abe3f464`). The DB read is the I/O shell; the grading
 * — the part a monitor's exit code depends on — is a pure function, so it is tested here without a live
 * Postgres. The end-to-end read against a real slot is exercised by the deployment's own runs (and the
 * pg acceptance gate already boots the real replication path).
 */

import { describe, expect, it } from "vitest";

import { classifySlotLag, formatBytes } from "./slot-lag-check";
import type { SlotLagReading, SlotLagThresholds } from "./slot-lag-check";

const THRESHOLDS: SlotLagThresholds = {
  warnBytes: 256 * 1024 * 1024,
  critBytes: 1024 * 1024 * 1024,
};

function reading(overrides: Partial<SlotLagReading> = {}): SlotLagReading {
  return { slot: "lesto_capstone", present: true, active: true, lagBytes: 0, ...overrides };
}

describe("classifySlotLag", () => {
  it("is OK for an active slot well under the warn threshold", () => {
    const verdict = classifySlotLag(reading({ lagBytes: 10 * 1024 * 1024 }), THRESHOLDS);

    expect(verdict.level).toBe("ok");
    expect(verdict.exitCode).toBe(0);
  });

  it("WARNs for an active slot at or over the warn threshold", () => {
    const verdict = classifySlotLag(reading({ lagBytes: THRESHOLDS.warnBytes }), THRESHOLDS);

    expect(verdict.level).toBe("warn");
    expect(verdict.exitCode).toBe(1);
  });

  it("is CRITICAL for an active slot at or over the crit threshold", () => {
    const verdict = classifySlotLag(reading({ lagBytes: THRESHOLDS.critBytes }), THRESHOLDS);

    expect(verdict.level).toBe("critical");
    expect(verdict.exitCode).toBe(2);
  });

  it("escalates an INACTIVE slot one notch — a wedged consumer's lag only grows", () => {
    // Under the warn threshold, but inactive → WARN (not OK): nobody is draining it.
    const low = classifySlotLag(reading({ active: false, lagBytes: 1024 }), THRESHOLDS);
    expect(low.level).toBe("warn");

    // Over the warn threshold AND inactive → CRITICAL: it will cross crit on its own.
    const mid = classifySlotLag(
      reading({ active: false, lagBytes: THRESHOLDS.warnBytes }),
      THRESHOLDS,
    );
    expect(mid.level).toBe("critical");
    expect(mid.message).toContain("INACTIVE");
  });

  it("WARNs on a MISSING slot — availability, not disk pressure", () => {
    const verdict = classifySlotLag(reading({ present: false, active: false }), THRESHOLDS);

    expect(verdict.level).toBe("warn");
    expect(verdict.message).toContain("not present");
  });

  it("is OK for a present-but-unreserved slot (restart_lsn null → lag unknown)", () => {
    const verdict = classifySlotLag(reading({ lagBytes: undefined }), THRESHOLDS);

    expect(verdict.level).toBe("ok");
    expect(verdict.message).toContain("—");
  });
});

describe("formatBytes", () => {
  it("renders whole bytes, then scales through binary units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(256 * 1024 * 1024)).toBe("256.0 MiB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GiB");
  });

  it("renders unknown lag as an em dash", () => {
    expect(formatBytes(undefined)).toBe("—");
  });
});
