import { describe, expect, test } from "bun:test";

import { isCanonical, renderProvenance, type BenchEnv } from "./env";

/** A fully-controlled, publication-grade environment. */
const canonical: BenchEnv = {
  recordedAt: "2026-01-01T00:00:00.000Z",
  gitSha: "abc1234",
  cpuModel: "AMD EPYC 7763",
  cpuCores: 16,
  memGiB: 32,
  os: "linux 6.1.0 x64",
  bunVersion: "1.3.5",
  nodeVersion: "v22.22.2",
  generator: "autocannon",
  generatorVersion: "8.0.0",
  frameworkVersions: { lesto: "abc1234", hono: "4.12.27" },
  governor: "performance",
  turboDisabled: true,
  serverCpus: "2,3",
  genCpus: "4,5",
};

describe("isCanonical", () => {
  test("true only when governor + turbo + both core pins are all set", () => {
    expect(isCanonical(canonical)).toBe(true);
  });

  test("false if the governor isn't performance", () => {
    expect(isCanonical({ ...canonical, governor: "powersave" })).toBe(false);
  });

  test("false if turbo is on or unknown", () => {
    expect(isCanonical({ ...canonical, turboDisabled: false })).toBe(false);
    expect(isCanonical({ ...canonical, turboDisabled: null })).toBe(false);
  });

  test("false if either core set is unpinned", () => {
    expect(isCanonical({ ...canonical, serverCpus: null })).toBe(false);
    expect(isCanonical({ ...canonical, genCpus: null })).toBe(false);
  });
});

describe("renderProvenance", () => {
  test("a canonical run stamps the matrix with NO warning banner", () => {
    const md = renderProvenance(canonical);

    expect(md).toContain("## Run provenance");
    expect(md).toContain("| commit | abc1234 |");
    expect(md).toContain("AMD EPYC 7763 (16 cores)");
    expect(md).toContain("32.0 GiB");
    expect(md).toContain("autocannon 8.0.0");
    expect(md).toContain("server=2,3 generator=4,5");
    expect(md).toContain("lesto abc1234, hono 4.12.27");
    expect(md).not.toContain("NON-CANONICAL");
    expect(md).not.toContain("⚠️");
  });

  test("a non-canonical run leads with the ⚠️ banner and flags the bad fields", () => {
    const md = renderProvenance({
      ...canonical,
      os: "darwin 24.1.0 arm64",
      governor: null,
      turboDisabled: null,
      serverCpus: null,
      genCpus: null,
    });

    expect(md).toContain("NON-CANONICAL HOST");
    expect(md).toContain("reproduce.ts --strict");
    expect(md).toContain("core pinning | none ⚠️");
    expect(md).toContain("turbo/boost | unknown");
  });

  test("an explicitly ENABLED turbo / wrong governor is marked, not hidden", () => {
    const md = renderProvenance({ ...canonical, governor: "powersave", turboDisabled: false });

    expect(md).toContain("powersave ⚠️");
    expect(md).toContain("ENABLED ⚠️");
  });

  test("missing optional values render as 'unknown', not blanks", () => {
    const md = renderProvenance({
      ...canonical,
      gitSha: null,
      bunVersion: null,
      nodeVersion: null,
      generatorVersion: null,
      frameworkVersions: {},
    });

    expect(md).toContain("| commit | unknown |");
    expect(md).toContain("| Bun | unknown |");
    expect(md).toContain("| frameworks | — |");
  });
});
