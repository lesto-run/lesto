import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreateLestoError, create } from "../src/index";
import type { CreateDeps, CreateOptions, RunResult, ScaffoldIO } from "../src/index";

/** A spy filesystem: records writes/mkdirs, never touches a real disk. */
function fakeIO(opts: { exists?: boolean } = {}): ScaffoldIO & {
  written: string[];
  dirs: string[];
} {
  const written: string[] = [];
  const dirs: string[] = [];

  return {
    written,
    dirs,
    exists: () => Promise.resolve(opts.exists ?? false),
    mkdir: (dir) => {
      dirs.push(dir);

      return Promise.resolve();
    },
    writeFile: (path) => {
      written.push(path);

      return Promise.resolve();
    },
  };
}

/** A scripted runner: returns a queued result per call, recording each invocation. */
function fakeRunner(
  script: (command: string, args: readonly string[]) => RunResult | Promise<RunResult>,
): {
  run: CreateDeps["run"];
  calls: Array<{ command: string; args: readonly string[]; cwd: string }>;
} {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

  return {
    calls,
    run: (command, args, cwd) => {
      calls.push({ command, args, cwd });

      return Promise.resolve(script(command, args));
    },
  };
}

const ok: RunResult = { code: 0, stdout: "", stderr: "" };

/** A base set of injected deps; individual tests override the pieces they exercise. */
function deps(overrides: Partial<CreateDeps> = {}): CreateDeps & { logs: string[] } {
  const logs: string[] = [];

  return {
    logs,
    io: overrides.io ?? fakeIO(),
    prompt: overrides.prompt ?? (() => Promise.resolve("")),
    run: overrides.run ?? (() => Promise.resolve(ok)),
    log: overrides.log ?? ((message) => logs.push(message)),
  };
}

/** A full options object with the on-by-default flags off (the quiet path). */
function options(overrides: Partial<CreateOptions> = {}): CreateOptions {
  return {
    cwd: "/work",
    local: false,
    yes: true,
    install: false,
    git: false,
    ...overrides,
  };
}

let consoleLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleLog.mockRestore();
  vi.restoreAllMocks();
});

describe("create — name resolution", () => {
  it("uses the CLI-provided name verbatim", async () => {
    const d = deps();

    const result = await create(options({ name: "acme" }), d);

    expect(result.name).toBe("acme");
    expect(result.targetDir).toBe("/work/acme");
  });

  it("takes the default name when none given and --yes is set (no prompt)", async () => {
    const prompt = vi.fn(() => Promise.resolve("ignored"));

    const result = await create(options({ yes: true }), deps({ prompt }));

    expect(result.name).toBe("lesto-app");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts for the name when none given and not --yes, using the answer", async () => {
    const prompt = vi.fn(() => Promise.resolve("from-prompt"));

    const result = await create(options({ yes: false }), deps({ prompt }));

    expect(prompt).toHaveBeenCalledOnce();
    expect(result.name).toBe("from-prompt");
  });

  it("falls back to the default when the prompt answer is blank", async () => {
    const result = await create(
      options({ yes: false }),
      deps({ prompt: () => Promise.resolve("") }),
    );

    expect(result.name).toBe("lesto-app");
  });
});

describe("create — name validation", () => {
  it.each(["", ".", "..", "has space", "a/b", "../escape"])(
    "refuses the invalid name %j with CREATE_LESTO_INVALID_NAME",
    async (bad) => {
      const error = await create(options({ name: bad }), deps()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CreateLestoError);
      expect((error as CreateLestoError).code).toBe("CREATE_LESTO_INVALID_NAME");
      expect((error as CreateLestoError).details).toEqual({ name: bad });
    },
  );

  it("accepts a name with dots, underscores and dashes", async () => {
    const result = await create(options({ name: "my_app-2.0" }), deps());

    expect(result.name).toBe("my_app-2.0");
  });
});

describe("create — scaffolding", () => {
  it("writes the starter and returns the sorted manifest", async () => {
    const io = fakeIO();

    const result = await create(options({ name: "acme" }), deps({ io }));

    expect(result.files.length).toBeGreaterThan(0);
    expect([...result.files]).toEqual(result.files.toSorted());
    // The file-routed home page + layout and the agent files are part of the starter.
    expect(result.files.some((p) => p.endsWith("app/routes/page.tsx"))).toBe(true);
    expect(result.files.some((p) => p.endsWith("app/routes/layout.tsx"))).toBe(true);
    expect(result.files.some((p) => p.endsWith("AGENTS.md"))).toBe(true);
    expect(result.files.some((p) => p.endsWith("CLAUDE.md"))).toBe(true);
    // The Claude Code skill rides along under .claude/skills/ (the agent on-ramp).
    expect(result.files.some((p) => p.includes(".claude") && p.endsWith("SKILL.md"))).toBe(true);
  });

  it("propagates the clobber refusal from scaffold (existing target)", async () => {
    const io = fakeIO({ exists: true });

    const error = await create(options({ name: "taken" }), deps({ io })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CreateLestoError);
    expect((error as CreateLestoError).code).toBe("CREATE_LESTO_TARGET_EXISTS");
  });

  it("logs to console.log when no log seam is injected", async () => {
    // Omit `log` so the default `console.log` branch runs (spied in beforeEach).
    await create(options({ name: "acme" }), {
      io: fakeIO(),
      prompt: () => Promise.resolve(""),
      run: () => Promise.resolve(ok),
    });

    expect(consoleLog).toHaveBeenCalled();
  });

  it("pins @lesto deps at file: paths under --local", async () => {
    const io = fakeIO();

    // Capture the package.json contents through a write-recording IO.
    let pkg = "";
    io.writeFile = (path, content) => {
      if (path.endsWith("package.json")) pkg = content;

      return Promise.resolve();
    };

    await create(options({ name: "acme", local: true }), deps({ io }));

    expect(pkg).toContain("file:");
    expect(pkg).not.toMatch(/"@lesto\/[a-z]+": "\^0\./);
  });
});

describe("create — install", () => {
  it("skips install when --no-install (install: false)", async () => {
    const runner = fakeRunner(() => ok);

    const result = await create(options({ name: "a", install: false }), deps({ run: runner.run }));

    expect(result.installed).toBe(false);
    expect(runner.calls.some((c) => c.command === "bun")).toBe(false);
  });

  it("runs `bun install` in the target dir on the install path", async () => {
    const runner = fakeRunner(() => ok);

    const result = await create(options({ name: "a", install: true }), deps({ run: runner.run }));

    expect(result.installed).toBe(true);
    expect(runner.calls).toContainEqual({ command: "bun", args: ["install"], cwd: "/work/a" });
  });

  it("throws CREATE_LESTO_INSTALL_FAILED on a non-zero install exit", async () => {
    const runner = fakeRunner((command) =>
      command === "bun" ? { code: 7, stdout: "", stderr: "boom" } : ok,
    );

    const error = await create(
      options({ name: "a", install: true }),
      deps({ run: runner.run }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CreateLestoError);
    expect((error as CreateLestoError).code).toBe("CREATE_LESTO_INSTALL_FAILED");
    expect((error as CreateLestoError).details).toMatchObject({
      targetDir: "/work/a",
      code: 7,
      stderr: "boom",
    });
  });
});

describe("create — git", () => {
  it("skips git when --no-git (git: false)", async () => {
    const runner = fakeRunner(() => ok);

    const result = await create(options({ name: "a", git: false }), deps({ run: runner.run }));

    expect(result.gitInitialized).toBe(false);
    expect(runner.calls.some((c) => c.command === "git")).toBe(false);
  });

  it("initializes a repo + commit when the target is not already in a repo", async () => {
    // `rev-parse --is-inside-work-tree` reports NOT inside (code 1); the init steps
    // then all succeed.
    const runner = fakeRunner((command, args) => {
      if (command === "git" && args[0] === "rev-parse") return { code: 1, stdout: "", stderr: "" };

      return ok;
    });

    const result = await create(options({ name: "a", git: true }), deps({ run: runner.run }));

    expect(result.gitInitialized).toBe(true);
    const gitCalls = runner.calls.filter((c) => c.command === "git").map((c) => c.args[0]);
    expect(gitCalls).toEqual(["rev-parse", "init", "add", "commit"]);
  });

  it("skips git when the target is already inside a repo", async () => {
    const runner = fakeRunner((command, args) => {
      if (command === "git" && args[0] === "rev-parse") return ok; // inside → code 0

      return ok;
    });

    const result = await create(options({ name: "a", git: true }), deps({ run: runner.run }));

    expect(result.gitInitialized).toBe(false);
    // Only the detection ran; no init/add/commit.
    expect(runner.calls.filter((c) => c.command === "git")).toHaveLength(1);
  });

  it("proceeds when the inside-repo check cannot spawn git (rejects)", async () => {
    // The detection run() rejects (git absent) — caught to `undefined`, so we fall
    // through to the init steps. The FIRST init step also rejects, so git is skipped.
    let first = true;
    const run: CreateDeps["run"] = () => {
      if (first) {
        first = false;

        return Promise.reject(new Error("spawn ENOENT"));
      }

      return Promise.reject(new Error("spawn ENOENT"));
    };

    const result = await create(options({ name: "a", git: true }), deps({ run }));

    expect(result.gitInitialized).toBe(false);
  });

  it("skips (does not throw) when a git step exits non-zero", async () => {
    const runner = fakeRunner((command, args) => {
      if (command === "git" && args[0] === "rev-parse") return { code: 1, stdout: "", stderr: "" };
      if (command === "git" && args[0] === "init") return { code: 128, stdout: "", stderr: "no" };

      return ok;
    });

    const result = await create(options({ name: "a", git: true }), deps({ run: runner.run }));

    expect(result.gitInitialized).toBe(false);
  });
});
