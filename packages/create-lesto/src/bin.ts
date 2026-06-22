#!/usr/bin/env bun
import { access, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { CreateLestoError, create } from "./index";
import type { CreateOptions, RunResult, ScaffoldIO } from "./index";

// Flags:
//   --local        pin @lesto/* at in-repo file: paths (in-monorepo dev / e2e)
//   --yes / -y     non-interactive: take every default, never prompt
//   --no-install   write files but skip `bun install`
//   --no-git       write files but skip `git init` + the initial commit
// The project name is the first non-flag argument (prompted for otherwise).
const argv = process.argv.slice(2);
const has = (...flags: string[]): boolean => flags.some((flag) => argv.includes(flag));
const name = argv.find((arg) => !arg.startsWith("-"));

const options: CreateOptions = {
  ...(name === undefined ? {} : { name }),
  cwd: process.cwd(),
  local: has("--local"),
  yes: has("--yes", "-y"),
  // `--no-install` / `--no-git` flip the on-by-default behavior off.
  install: !has("--no-install"),
  git: !has("--no-git"),
};

const io: ScaffoldIO = {
  mkdir: async (dir: string) => void (await mkdir(dir, { recursive: true })),
  writeFile: (path: string, content: string) => writeFile(path, content),
  exists: (path: string) =>
    access(path)
      .then(() => true)
      .catch(() => false),
};

// One prompt over the real terminal. Closed after each question so a `--yes` run
// (which never asks) leaves no dangling readline interface holding stdin open.
const prompt = async (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
};

// Spawn a command in `cwd`, inheriting stdio (so `bun install`'s progress shows
// live) while still capturing stderr for a coded-error's details. Resolves with
// the result on any exit; rejects only if the command could not be spawned at all
// (e.g. `git` is not on PATH) — which the flow treats as a git-step skip.
const run = (command: string, args: readonly string[], cwd: string): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ["inherit", "inherit", "pipe"] });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: "", stderr }));
  });

try {
  const result = await create(options, { io, prompt, run });

  const next = result.installed
    ? `cd ${result.name} && bun run dev`
    : `cd ${result.name} && bun install && bun run dev`;

  console.log(`\nDone. Next: ${next}`);
} catch (error) {
  if (!(error instanceof CreateLestoError)) throw error;

  console.error(`error[${error.code}]: ${error.message}`);
  process.exit(1);
}
