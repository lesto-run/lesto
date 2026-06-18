import { stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { AnyCollection } from "./types";
import type { ResolvedConfig } from "./config";
import { resolveParser, getDefaultIncludePatterns } from "@volo/content-umbra";

export interface CollectedFile {
  absolutePath: string;
  relativePath: string;
  collection: AnyCollection;
}

function normalizePatterns(patterns: string | string[] | undefined): string[] {
  if (patterns === undefined) {
    return [];
  }
  return Array.isArray(patterns) ? patterns : [patterns];
}

function getCollectionIncludePatterns(collection: AnyCollection): string[] {
  if (collection.include !== undefined) {
    return normalizePatterns(collection.include);
  }

  const parser = resolveParser(collection.parser);
  const parserPatterns = getDefaultIncludePatterns(parser);
  return parserPatterns.length > 0 ? parserPatterns : ["**/*.md"];
}

async function collectCollection(collection: AnyCollection, cwd: string): Promise<CollectedFile[]> {
  const absoluteDir = path.isAbsolute(collection.directory)
    ? collection.directory
    : path.join(cwd, collection.directory);

  try {
    const stats = await stat(absoluteDir);
    if (!stats.isDirectory()) {
      console.warn(
        `[docks] "${collection.directory}" is not a directory, ` +
          `skipping collection "${collection.name}"`,
      );
      return [];
    }
  } catch {
    console.warn(
      `[docks] Directory "${collection.directory}" not found, ` +
        `skipping collection "${collection.name}"`,
    );
    return [];
  }

  const include = getCollectionIncludePatterns(collection);
  const exclude = normalizePatterns(collection.exclude);

  const paths = await fg(include, {
    cwd: absoluteDir,
    absolute: true,
    ignore: ["**/node_modules/**", ...exclude],
  });

  return paths.map((absolutePath) => ({
    absolutePath,
    relativePath: path.relative(absoluteDir, absolutePath),
    collection,
  }));
}

export async function collect(config: ResolvedConfig): Promise<CollectedFile[]> {
  const results = await Promise.all(
    config.collections.map((collection) => collectCollection(collection, config.cwd)),
  );

  return results.flat();
}

export async function collectOne(collection: AnyCollection, cwd: string): Promise<CollectedFile[]> {
  return collectCollection(collection, cwd);
}
