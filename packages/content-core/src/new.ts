import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveConfig } from "./config";
import { getSchemaDef, getSchemaTypeName } from "./schema-introspector";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

interface GitUserInfo {
  name?: string;
  email?: string;
}

async function getGitUserInfo(): Promise<GitUserInfo> {
  const info: GitUserInfo = {};

  try {
    const { stdout: name } = await execAsync("git config user.name");
    info.name = name.trim();
  } catch {}

  try {
    const { stdout: email } = await execAsync("git config user.email");
    info.email = email.trim();
  } catch {}

  return info;
}

interface TemplateVariables {
  title: string;
  slug: string;
  date: string;
  git: GitUserInfo;
}

function substituteVariables(template: string, variables: TemplateVariables): string {
  return template
    .replace(/\{\{title\}\}/g, variables.title)
    .replace(/\{\{slug\}\}/g, variables.slug)
    .replace(/\{\{date\}\}/g, variables.date)
    .replace(/\{\{git\.user\}\}/g, variables.git.name || "")
    .replace(/\{\{git\.email\}\}/g, variables.git.email || "");
}

function getDefaultValue(fieldName: string, schema: unknown, title: string): string {
  const def = getSchemaDef(schema);
  const typeName = getSchemaTypeName(schema);

  // Check if it has a default value
  if (def?.type === "default" && def.defaultValue !== undefined) {
    const defaultVal =
      typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
    if (typeof defaultVal === "boolean") {
      return String(defaultVal);
    }
    if (typeof defaultVal === "string") {
      return `"${defaultVal}"`;
    }
    if (defaultVal instanceof Date) {
      return `"${defaultVal.toISOString()}"`;
    }
  }

  // Special handling for title field
  if (fieldName === "title") {
    return `"${title}"`;
  }

  // Type-based defaults - handler registry per AGENTS.md
  const handler = TYPE_DEFAULT_HANDLERS[typeName];
  return handler ? handler() : '""';
}

/** Handler registry for type defaults - per AGENTS.md pattern */
const TYPE_DEFAULT_HANDLERS: Record<string, () => string> = {
  date: () => `"${new Date().toISOString()}"`,
  boolean: () => "false",
  number: () => "0",
  array: () => "[]",
};

function generateFrontmatter(schema: unknown, title: string): string {
  // Access the shape from schema def
  const def = getSchemaDef(schema);
  const shape =
    def?.type === "object" ? (def as { shape?: Record<string, unknown> }).shape : undefined;

  if (!shape) {
    // Fallback if we can't read the schema
    return `---
title: "${title}"
---`;
  }

  const lines = ["---"];

  for (const [fieldName, fieldSchema] of Object.entries(shape)) {
    const value = getDefaultValue(fieldName, fieldSchema, title);

    // Handle arrays differently
    if (value === "[]") {
      lines.push(`${fieldName}: []`);
    } else {
      lines.push(`${fieldName}: ${value}`);
    }
  }

  lines.push("---");

  return lines.join("\n");
}

export async function createNewEntry(
  cwd: string,
  collectionName: string,
  title: string,
): Promise<void> {
  // Load config
  const config = await resolveConfig(cwd);

  // Find collection
  const collection = config.collections.find((c) => c.name === collectionName);
  if (!collection) {
    console.error(`Error: Collection "${collectionName}" not found.`);
    console.error(`Available collections: ${config.collections.map((c) => c.name).join(", ")}`);
    process.exit(1);
  }

  // Generate filename from title
  const slug = slugify(title);
  const fileName = `${slug}.md`;
  const filePath = path.join(cwd, collection.directory, fileName);

  try {
    await access(filePath);
    console.error(`Error: File already exists at ${collection.directory}/${fileName}`);
    process.exit(1);
  } catch {}

  // Immutable content generation - per AGENTS.md
  const content = collection.template
    ? substituteVariables(collection.template, {
        title,
        slug,
        date: new Date().toISOString(),
        git: await getGitUserInfo(),
      })
    : `${generateFrontmatter(collection.schema, title)}

# ${title}

Start writing your content here...
`;

  await writeFile(filePath, content, "utf-8");

  console.log(`Created new entry: ${collection.directory}/${fileName}`);
}
