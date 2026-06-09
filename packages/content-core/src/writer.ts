import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig } from "./config";
import { generateTypes } from "./typegen";

export interface WriteOptions {
  outDir?: string;
}

export interface WriteResult {
  typesPath: string;
  typesContent: string;
}

export async function write(
  config: ResolvedConfig,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const outDir = options.outDir ?? path.join(config.cwd, "node_modules", ".docks");
  await mkdir(outDir, { recursive: true });

  const typesContent = generateTypes(config.collections, config.taxonomies);
  const typesPath = path.join(outDir, "types.d.ts");
  await writeFile(typesPath, typesContent, "utf-8");

  return { typesPath, typesContent };
}
