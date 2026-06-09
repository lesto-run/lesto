import { access } from "node:fs/promises";
import path from "node:path";
import type { AnyCollection, EngineConfig, ValidationMode } from "./types";
import type { AnyTaxonomy } from "./taxonomy";

export const CONFIG_FILE_NAMES = [
  "docks.config.ts",
  "docks.config.js",
  "docks.config.mjs",
] as const;

export type ConfigFileExtension = ".ts" | ".js" | ".mjs";

export interface ResolvedConfigFile {
  path: string;
  ext: ConfigFileExtension;
}

export interface ResolvedConfig {
  configPath: string | null;
  cwd: string;
  collections: AnyCollection[];
  taxonomies: AnyTaxonomy[];
  mode: ValidationMode;
  assets?: EngineConfig["assets"];
  deploy?: EngineConfig["deploy"];
  onValidationWarning?: EngineConfig["onValidationWarning"];
  onTransformError?: EngineConfig["onTransformError"];
  onSerializationWarning?: EngineConfig["onSerializationWarning"];
}

export async function resolveConfigFile(cwd: string): Promise<ResolvedConfigFile | undefined> {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(cwd, name);
    try {
      await access(candidate);
      const ext = path.extname(candidate) as ConfigFileExtension;
      return { path: candidate, ext };
    } catch {}
  }
  return undefined;
}

async function loadConfigFile(configPath: string): Promise<EngineConfig> {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(configPath);
  const mod = await jiti.import(configPath);
  const config = (mod as { default?: unknown }).default ?? mod;

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid config at ${configPath}: expected object with collections array`);
  }

  return config as EngineConfig;
}

/** Throw a validation error with source context */
function validationError(source: string, fieldPath: string, reason: string): never {
  throw new Error(`Invalid config (${source}): ${fieldPath} ${reason}`);
}

/** Assert value is not null or undefined */
function assertRequired<T>(
  value: T | undefined | null,
  source: string,
  fieldPath: string,
): asserts value is T {
  if (value === undefined || value === null) {
    validationError(source, fieldPath, "is required");
  }
}

/** Assert value is a non-empty string */
function assertString(
  value: unknown,
  source: string,
  fieldPath: string,
): asserts value is string {
  if (typeof value !== "string" || !value) {
    validationError(source, fieldPath, "must be a non-empty string");
  }
}

/** Assert value is an array */
function assertArray<T>(
  value: unknown,
  source: string,
  fieldPath: string,
): asserts value is T[] {
  if (!Array.isArray(value)) {
    validationError(source, fieldPath, "must be an array");
  }
}

/** Assert value is an object (not null, not array) */
function assertObject(
  value: unknown,
  source: string,
  fieldPath: string,
): asserts value is object {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    validationError(source, fieldPath, "must be an object");
  }
}

function validateConfig(config: EngineConfig, source: string): void {
  assertArray(config.collections, source, "collections");
  config.collections.forEach((col, i) => {
    assertString(col.name, source, `collections[${i}].name`);
    assertString(col.directory, source, `collections[${i}].directory`);
    assertRequired(col.schema, source, `collections[${i}].schema`);
  });

  if (config.taxonomies) {
    assertArray(config.taxonomies, source, "taxonomies");
    config.taxonomies.forEach((tax, i) => {
      assertObject(tax, source, `taxonomies[${i}]`);
      assertString((tax as { name?: unknown }).name, source, `taxonomies[${i}].name`);
      assertArray((tax as { terms?: unknown }).terms, source, `taxonomies[${i}].terms`);
    });
  }
}

export async function resolveConfig(
  cwd: string,
  programmaticConfig?: EngineConfig,
): Promise<ResolvedConfig> {
  if (programmaticConfig) {
    validateConfig(programmaticConfig, "programmatic");
    return {
      configPath: null,
      cwd,
      collections: programmaticConfig.collections,
      taxonomies: programmaticConfig.taxonomies ?? [],
      mode: programmaticConfig.mode ?? "development",
      assets: programmaticConfig.assets,
      deploy: programmaticConfig.deploy,
      onValidationWarning: programmaticConfig.onValidationWarning,
      onTransformError: programmaticConfig.onTransformError,
      onSerializationWarning: programmaticConfig.onSerializationWarning,
    };
  }

  const configFile = await resolveConfigFile(cwd);

  if (!configFile) {
    throw new Error(
      `No docks.config.{ts,js,mjs} found in ${cwd}. ` +
        `Create a config file with defineConfig({ collections: [...] })`,
    );
  }

  const config = await loadConfigFile(configFile.path);
  validateConfig(config, configFile.path);

  return {
    configPath: configFile.path,
    cwd,
    collections: config.collections,
    taxonomies: config.taxonomies ?? [],
    mode: config.mode ?? "development",
    assets: config.assets,
    deploy: config.deploy,
    onValidationWarning: config.onValidationWarning,
    onTransformError: config.onTransformError,
    onSerializationWarning: config.onSerializationWarning,
  };
}
