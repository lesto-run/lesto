#!/usr/bin/env bun
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CreateVoloError, fileColonPin, scaffold } from "./index";

// `--local` pins `@volo/*` deps at in-repo `file:` paths (in-monorepo dev / e2e)
// instead of the default published `^0.x` ranges. The project name is the first
// non-flag argument.
const argv = process.argv.slice(2);
const local = argv.includes("--local");
const name = argv.find((arg) => !arg.startsWith("-")) ?? "volo-app";
const targetDir = join(process.cwd(), name);

const io = {
  mkdir: async (dir: string) => void (await mkdir(dir, { recursive: true })),
  writeFile: (path: string, content: string) => writeFile(path, content),
  exists: (path: string) =>
    access(path)
      .then(() => true)
      .catch(() => false),
};

try {
  const files = await scaffold(
    local ? { name, targetDir, voloDep: fileColonPin } : { name, targetDir },
    io,
  );
  console.log(
    `Scaffolded ${name} (${files.length} files). Next: cd ${name} && bun install && bun run dev`,
  );
} catch (error) {
  if (!(error instanceof CreateVoloError)) throw error;
  console.error(`error[${error.code}]: ${error.message}`);
  process.exit(1);
}
