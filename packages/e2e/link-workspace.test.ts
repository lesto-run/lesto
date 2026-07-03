import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compareVersionDesc,
  ensureRealScopeDir,
  majorPredicate,
  pickStoreEntry,
} from "./link-workspace";

// `linkWorkspaceInto` reconstructs a scaffolded app's node_modules from the repo's OWN bun store,
// so its version-pick and scope-materialize helpers are the exact class where F1 (semver-blind
// pick) and F2 (scoped write escaping into the repo checkout) hid. `packages/e2e` declares no
// `test:cov` and is coverage-gate-exempt, so before this file those helpers had NO unit guard —
// this covers them directly (`bunx vitest run packages/e2e/link-workspace.test.ts`).

describe("pickStoreEntry", () => {
  // Store dirs are `<name>@<version>[+peerhash]`; the caller builds `prefix` as `<name>@`.
  const zod = "zod@";

  it("picks the highest satisfying major regardless of readdir (hash) order — the F1 repro", () => {
    // Both `zod@3` and `zod@4` in the store; an app declaring `^4` must get 4, whichever the
    // filesystem lists first. The old `matches.find(...)` returned whichever came first.
    expect(pickStoreEntry("zod", "^4", zod, ["zod@3.23.8", "zod@4.1.0"])).toBe("zod@4.1.0");
    expect(pickStoreEntry("zod", "^4", zod, ["zod@4.1.0", "zod@3.23.8"])).toBe("zod@4.1.0");
    expect(pickStoreEntry("zod", "^3", zod, ["zod@4.1.0", "zod@3.23.8"])).toBe("zod@3.23.8");
  });

  it("takes the highest version within the satisfying major", () => {
    expect(pickStoreEntry("zod", "^4", zod, ["zod@4.0.1", "zod@4.2.0", "zod@3.9.9"])).toBe(
      "zod@4.2.0",
    );
  });

  it("returns a lone match that satisfies the declared range", () => {
    expect(pickStoreEntry("zod", "^4", zod, ["zod@4.1.0"])).toBe("zod@4.1.0");
  });

  it("THROWS on a lone match whose major misses the declared range (the F1-shape residual)", () => {
    // Store holds only `zod@3` but the app declares `^4`: a single entry is NOT a licence to skip
    // the range check. Must fail loud, not silently link the wrong major.
    expect(() => pickStoreEntry("zod", "^4", zod, ["zod@3.23.8"])).toThrowError(
      /has only 3\.23\.8 .*"\^4" does not accept its major/,
    );
  });

  it("returns a lone match as-is when the range pins no major (nothing to be wrong about)", () => {
    expect(pickStoreEntry("foo", "*", "foo@", ["foo@1.0.0"])).toBe("foo@1.0.0");
    expect(pickStoreEntry("foo", "workspace:*", "foo@", ["foo@1.0.0"])).toBe("foo@1.0.0");
    expect(pickStoreEntry("foo", undefined, "foo@", ["foo@1.0.0"])).toBe("foo@1.0.0");
  });

  it("THROWS when several entries exist but none satisfies the declared major", () => {
    expect(() => pickStoreEntry("zod", "^4", zod, ["zod@2.0.0", "zod@3.0.0"])).toThrowError(
      /satisfies none of them/,
    );
  });

  it("THROWS when several entries exist and the range pins no major to choose by", () => {
    expect(() => pickStoreEntry("zod", "*", zod, ["zod@3.0.0", "zod@4.0.0"])).toThrowError(
      /does not pin a major/,
    );
  });

  it("compares on semver only (peer-hash build metadata stripped) and breaks ties deterministically", () => {
    // Same version, different peer-hash → lexical name tiebreak, stable across input order.
    const variants = ["react-dom@19.2.7+deadbeef", "react-dom@19.2.7+00c0ffee"];
    expect(pickStoreEntry("react-dom", "^19", "react-dom@", variants)).toBe(
      "react-dom@19.2.7+00c0ffee",
    );
    // Different versions carrying peer-hashes still order by the bare version.
    expect(pickStoreEntry("pkg", ">=1", "pkg@", ["pkg@1.0.0+a", "pkg@2.0.0+b"])).toBe(
      "pkg@2.0.0+b",
    );
  });
});

describe("majorPredicate", () => {
  it("reads caret / tilde / bare / dotted / x ranges as a single major", () => {
    for (const range of ["^19", "~19.1", "19", "19.x", "19.2.0"]) {
      const p = majorPredicate(range);
      expect(p.constrained).toBe(true);
      expect(p.test(19)).toBe(true);
      expect(p.test(18)).toBe(false);
      expect(p.test(20)).toBe(false);
    }
  });

  it("reads a `>=` lower bound as an open-ended floor", () => {
    const p = majorPredicate(">=18");
    expect(p.constrained).toBe(true);
    expect(p.test(17)).toBe(false);
    expect(p.test(18)).toBe(true);
    expect(p.test(99)).toBe(true);
  });

  it("accepts any alternative of a `||` union", () => {
    const p = majorPredicate("^4 || ^5");
    expect(p.constrained).toBe(true);
    expect(p.test(4)).toBe(true);
    expect(p.test(5)).toBe(true);
    expect(p.test(3)).toBe(false);
    expect(p.test(6)).toBe(false);
  });

  it("reports UNCONSTRAINED (constrained:false, always-true) for un-pinnable ranges", () => {
    for (const range of [
      undefined,
      "||", // no non-empty alternatives
      "*",
      "x",
      "latest",
      "workspace:*",
      "file:../local",
      "link:../local",
      "npm:react@^19",
      "github:owner/repo",
      "https://example.test/pkg.tgz",
      ">=18 <20", // compound range: internal whitespace → refuse to guess
      "1.2.3 - 2.0.0", // hyphen range: same
      "^abc", // unreadable alternative (no numeric major)
    ]) {
      const p = majorPredicate(range);
      expect(p.constrained).toBe(false);
      expect(p.test(1)).toBe(true);
      expect(p.test(999)).toBe(true);
    }
  });
});

describe("compareVersionDesc", () => {
  it("orders high → low across major, minor, and patch", () => {
    expect(compareVersionDesc("4.0.0", "3.0.0")).toBeLessThan(0); // a higher → sorts first
    expect(compareVersionDesc("3.0.0", "4.0.0")).toBeGreaterThan(0);
    expect(compareVersionDesc("4.2.0", "4.1.0")).toBeLessThan(0);
    expect(compareVersionDesc("4.1.5", "4.1.2")).toBeLessThan(0);
  });

  it("treats missing components as zero and equal versions as a tie", () => {
    expect(compareVersionDesc("4.1.2", "4.1.2")).toBe(0);
    expect(compareVersionDesc("4", "4.0.1")).toBeGreaterThan(0); // 4 === 4.0.0 < 4.0.1
  });
});

describe("ensureRealScopeDir", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "link-workspace-scope-"));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("creates the scope dir when it is absent", async () => {
    const scope = join(base, "app", "node_modules", "@types");
    await ensureRealScopeDir(scope);
    expect(existsSync(scope)).toBe(true);
    expect((await lstat(scope)).isSymbolicLink()).toBe(false);
  });

  it("leaves an already-real scope dir (and its contents) untouched", async () => {
    const scope = join(base, "@vitest");
    await mkdir(scope, { recursive: true });
    await writeFile(join(scope, "keep"), "x");
    await ensureRealScopeDir(scope);
    expect((await lstat(scope)).isSymbolicLink()).toBe(false);
    expect(existsSync(join(scope, "keep"))).toBe(true);
  });

  it("materializes a symlinked scope into a real dir so later writes never escape into the target (F2)", async () => {
    // The root sweep links whole scope dirs as ONE symlink to the repo's real scope. A scoped dep
    // the app adds would otherwise be written THROUGH that symlink, mutating the repo checkout.
    const repoScope = join(base, "repo", "@types");
    await mkdir(repoScope, { recursive: true });
    await writeFile(join(repoScope, "node"), "provided-by-root");

    const appScope = join(base, "app", "@types");
    await mkdir(join(base, "app"), { recursive: true });
    await symlink(repoScope, appScope);
    expect((await lstat(appScope)).isSymbolicLink()).toBe(true);

    await ensureRealScopeDir(appScope);

    // Now a real dir that re-links what the symlink pointed at — nothing the root scope gave is lost.
    expect((await lstat(appScope)).isSymbolicLink()).toBe(false);
    expect(await readdir(appScope)).toContain("node");

    // The whole point: a NEW scoped entry lands inside the app, NOT back in the repo's real scope.
    await writeFile(join(appScope, "app-only"), "y");
    expect(existsSync(join(appScope, "app-only"))).toBe(true);
    expect(existsSync(join(repoScope, "app-only"))).toBe(false);
  });
});
