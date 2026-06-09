#!/usr/bin/env bun
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CreateKeelError, scaffold } from "./index";

const name = process.argv[2] ?? "keel-app";
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
  const files = await scaffold({ name, targetDir }, io);
  console.log(
    `Scaffolded ${name} (${files.length} files). Next: cd ${name} && bun install && bun run dev`,
  );
} catch (error) {
  if (!(error instanceof CreateKeelError)) throw error;
  console.error(`error[${error.code}]: ${error.message}`);
  process.exit(1);
}
