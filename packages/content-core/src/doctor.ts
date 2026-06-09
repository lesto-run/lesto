import { existsSync } from "node:fs";
import path from "node:path";
import type { RuntimeEntry, AnyCollection } from "./types";

export interface DoctorOptions {
  checks?: ("links" | "images")[];
  /** Directory for absolute image paths (e.g., "/image.png"). Default: "public" */
  publicDir?: string;
}

export interface DoctorConfig {
  cwd?: string;
  /** Collection configs - required for resolving file paths */
  collections?: AnyCollection[];
}

export interface DoctorResult {
  errors: DoctorIssue[];
  warnings: DoctorIssue[];
}

export interface DoctorIssue {
  type: "link" | "image" | "ref";
  severity: "error" | "warning";
  file: string;
  message: string;
  line?: number;
}

function buildCollectionDirs(collections: AnyCollection[], cwd: string): Map<string, string> {
  const collectionDirs = new Map<string, string>();
  for (const collection of collections) {
    const absDir = path.isAbsolute(collection.directory)
      ? collection.directory
      : path.join(cwd, collection.directory);
    collectionDirs.set(collection.name, absDir);
  }
  return collectionDirs;
}

function buildSlugsByCollection(entries: RuntimeEntry[]): Map<string, Set<string>> {
  const slugsByCollection = new Map<string, Set<string>>();
  for (const entry of entries) {
    const set = slugsByCollection.get(entry.collection) ?? new Set();
    set.add(entry["slug"] as string);
    slugsByCollection.set(entry.collection, set);
  }
  return slugsByCollection;
}

function getEntryFilePath(entry: RuntimeEntry, collectionDirs: Map<string, string>): string {
  const collectionDir = collectionDirs.get(entry.collection);
  return collectionDir
    ? path.join(collectionDir, entry.file.path)
    : path.join(entry.file.directory, entry.file.path);
}

export async function doctor(
  entries: RuntimeEntry[],
  config: DoctorConfig,
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const checks = options.checks ?? ["links", "images"];
  const publicDir = options.publicDir ?? "public";
  const issues: DoctorIssue[] = [];
  const cwd = config.cwd ?? process.cwd();

  const collectionDirs = buildCollectionDirs(config.collections ?? [], cwd);
  const slugsByCollection = buildSlugsByCollection(entries);

  for (const entry of entries) {
    const filePath = getEntryFilePath(entry, collectionDirs);

    if (checks.includes("links")) {
      issues.push(...checkInternalLinks(entry, slugsByCollection, filePath));
    }
    if (checks.includes("images")) {
      issues.push(...checkImages(entry, cwd, publicDir, filePath));
    }
  }

  return {
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity === "warning"),
  };
}

function checkInternalLinks(
  entry: RuntimeEntry,
  slugs: Map<string, Set<string>>,
  filePath: string,
): DoctorIssue[] {
  const issues: DoctorIssue[] = [];

  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;

  while ((match = linkRe.exec(entry["content"] as string))) {
    const href = match[2] ?? "";

    if (href.startsWith("http") || href.startsWith("#") || href.startsWith("mailto:")) continue;

    const parts = href.replace(/^\//, "").split("/");
    if (parts.length === 2) {
      const col = parts[0] ?? "";
      const slug = parts[1] ?? "";
      const collectionSlugs = slugs.get(col);
      if (collectionSlugs && !collectionSlugs.has(slug.replace(/\.md$/, ""))) {
        issues.push({
          type: "link",
          severity: "error",
          file: filePath,
          message: `Broken link: ${href}`,
        });
      }
    }
  }

  return issues;
}

function checkImages(
  entry: RuntimeEntry,
  cwd: string,
  publicDir: string,
  filePath: string,
): DoctorIssue[] {
  const issues: DoctorIssue[] = [];

  const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;

  while ((match = imgRe.exec(entry["content"] as string))) {
    const src = match[2] ?? "";

    if (src.startsWith("http") || src.startsWith("data:")) continue;

    const imagePath = src.startsWith("/")
      ? path.join(cwd, publicDir, src)
      : path.join(path.dirname(filePath), src);

    if (!existsSync(imagePath)) {
      issues.push({
        type: "image",
        severity: "error",
        file: filePath,
        message: `Missing image: ${src}`,
      });
    }
  }

  return issues;
}
