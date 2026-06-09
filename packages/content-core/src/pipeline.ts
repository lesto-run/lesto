import { resolveConfig, type ResolvedConfig } from "./config";
import { collect, type CollectedFile } from "./collector";
import { parse, type ParseResult } from "./parser";
import { transform, type TransformResult } from "./transformer";
import { write, type WriteResult } from "./writer";
import { createCacheManager, type CacheOptions, type CacheStats } from "./cache";
import type { EngineConfig, RuntimeEntry, AnyCollection, ValidationError } from "./types";
import type { AnyTaxonomy } from "./taxonomy";
import { getTaxonomySlugs } from "./taxonomy";
import { isReference, getReferenceTarget } from "./reference";
import { getSchemaDef } from "./schema-introspector";

export interface PipelineResult {
  config: ResolvedConfig;
  files: CollectedFile[];
  parseResult: ParseResult;
  transformResult: TransformResult;
  writeResult: WriteResult;
  entries: RuntimeEntry[];
  cacheStats?: CacheStats;
}

export interface PipelineOptions {
  cwd?: string;
  config?: EngineConfig;
  outDir?: string;
  skipWrite?: boolean;
  cache?: CacheOptions;
}

function unwrapSchema(schema: unknown): unknown {
  const def = getSchemaDef(schema);
  if (def?.type === "optional" || def?.type === "default" || def?.type === "nullable") {
    return unwrapSchema(def.innerType ?? def.in);
  }
  return schema;
}

function extractRefInfo(fieldSchema: unknown): { refSchema: unknown; isArray: boolean } | null {
  let refSchema = unwrapSchema(fieldSchema);
  let isArray = false;

  const fieldDef = getSchemaDef(refSchema);
  if (fieldDef?.type === "array") {
    refSchema = unwrapSchema(fieldDef.element);
    isArray = true;
  }

  if (!isReference(refSchema)) return null;
  return { refSchema, isArray };
}

function validateEntryReference(
  entry: RuntimeEntry,
  field: string,
  isArray: boolean,
  validValues: Set<string>,
  isTaxonomyRef: boolean,
  targetName: string,
  configName: string,
): string[] {
  const errors: string[] = [];
  const refValue = (entry as Record<string, unknown>)[field];
  const entrySlug = (entry as Record<string, unknown>)["slug"] as string;

  if (refValue === undefined || refValue === null) return errors;

  const values = isArray && Array.isArray(refValue) ? refValue : [refValue];
  for (const v of values) {
    if (!validValues.has(v as string)) {
      const message = isTaxonomyRef
        ? `${configName}/${entrySlug}: "${field}" references invalid taxonomy term "${v}" in ${targetName}`
        : `${configName}/${entrySlug}: "${field}" references non-existent ${targetName}/${v}`;
      errors.push(message);
    }
  }
  return errors;
}

function validateFieldReferences(
  config: AnyCollection,
  field: string,
  fieldSchema: unknown,
  collections: Map<string, RuntimeEntry[]>,
  collectionSlugs: Map<string, Set<string>>,
  taxonomyTerms: Map<string, Set<string>>,
): string[] {
  const errors: string[] = [];
  const refInfo = extractRefInfo(fieldSchema);
  if (!refInfo) return errors;

  const targetName = getReferenceTarget(refInfo.refSchema);
  if (!targetName) return errors;

  const isTaxonomyRef = taxonomyTerms.has(targetName);
  const isCollectionRef = collectionSlugs.has(targetName);

  if (!isTaxonomyRef && !isCollectionRef) {
    errors.push(`Collection "${config.name}" references unknown collection "${targetName}"`);
    return errors;
  }

  const validValues = isTaxonomyRef
    ? taxonomyTerms.get(targetName)!
    : collectionSlugs.get(targetName)!;

  const entries = collections.get(config.name) ?? [];
  for (const entry of entries) {
    errors.push(...validateEntryReference(
      entry, field, refInfo.isArray, validValues, isTaxonomyRef, targetName, config.name
    ));
  }
  return errors;
}

function validateReferences(
  collections: Map<string, RuntimeEntry[]>,
  configs: AnyCollection[],
  taxonomies: AnyTaxonomy[],
): string[] {
  const errors: string[] = [];

  // Pre-build all valid slugs per collection (O(n) once instead of O(n) per field)
  const collectionSlugs = new Map<string, Set<string>>();
  for (const [name, entries] of collections) {
    collectionSlugs.set(
      name,
      new Set(entries.map((e) => (e as Record<string, unknown>)["slug"] as string))
    );
  }

  const taxonomyTerms = new Map<string, Set<string>>();
  for (const tax of taxonomies) {
    taxonomyTerms.set(tax.name, new Set(getTaxonomySlugs(tax)));
  }

  for (const config of configs) {
    const def = getSchemaDef(config.schema);
    const shape = def?.shape;
    if (!shape) continue;

    for (const [field, fieldSchema] of Object.entries(shape)) {
      errors.push(...validateFieldReferences(
        config, field, fieldSchema, collections, collectionSlugs, taxonomyTerms
      ));
    }
  }

  return errors;
}

function validateUniqueNames(
  collections: AnyCollection[],
  taxonomies: AnyTaxonomy[],
): string[] {
  const errors: string[] = [];
  const collectionNames = new Set(collections.map((c) => c.name));

  // Check for duplicate taxonomy names
  const seenTaxonomyNames = new Set<string>();
  for (const tax of taxonomies) {
    if (seenTaxonomyNames.has(tax.name)) {
      errors.push(`Duplicate taxonomy name "${tax.name}"`);
    }
    seenTaxonomyNames.add(tax.name);
  }

  // Check for taxonomy/collection name conflicts
  for (const tax of taxonomies) {
    if (collectionNames.has(tax.name)) {
      errors.push(`Taxonomy "${tax.name}" conflicts with collection of the same name`);
    }
  }

  return errors;
}

function validateTaxonomyTermType(tax: AnyTaxonomy): string | null {
  const firstTerm = tax.terms[0];
  const hasSchema = "schema" in tax;
  const termsAreStrings = typeof firstTerm === "string";
  const termsAreObjects = typeof firstTerm === "object" && firstTerm !== null;

  if (hasSchema && termsAreStrings) {
    return `Taxonomy "${tax.name}" has a schema but terms are strings`;
  }
  if (!hasSchema && termsAreObjects) {
    return `Taxonomy "${tax.name}" uses object terms but has no schema`;
  }
  if (!termsAreStrings && !termsAreObjects) {
    return `Taxonomy "${tax.name}" terms must be strings or objects`;
  }
  return null;
}

function validateTaxonomyDuplicates(tax: AnyTaxonomy): string[] {
  const errors: string[] = [];
  const slugs = getTaxonomySlugs(tax);
  const seen = new Set<string>();
  for (const slug of slugs) {
    if (seen.has(slug)) {
      errors.push(`Taxonomy "${tax.name}" has duplicate term "${slug}"`);
    }
    seen.add(slug);
  }
  return errors;
}

function validateTaxonomyTerms(taxonomies: AnyTaxonomy[]): string[] {
  const errors: string[] = [];

  for (const tax of taxonomies) {
    if (tax.terms.length === 0) {
      errors.push(`Taxonomy "${tax.name}" has no terms defined`);
      continue;
    }

    const typeError = validateTaxonomyTermType(tax);
    if (typeError) {
      errors.push(typeError);
    }

    errors.push(...validateTaxonomyDuplicates(tax));
  }

  return errors;
}

function reportParseErrors(errors: ValidationError[], config: ResolvedConfig): void {
  for (const error of errors) {
    if (config.onValidationWarning) {
      config.onValidationWarning(error);
    } else {
      console.warn(`[docks] ${error.message}`);
    }
  }
}

function reportTransformErrors(result: TransformResult, config: ResolvedConfig): void {
  for (const error of result.errors) {
    if (config.onTransformError) {
      config.onTransformError(error);
    } else {
      console.warn(`[docks] ${error.message}`);
    }
  }
  for (const error of result.serializationErrors) {
    if (config.onSerializationWarning) {
      config.onSerializationWarning(error);
    } else {
      console.warn(`[docks] ${error.message}`);
    }
  }
}

function buildCollectionMap(entries: RuntimeEntry[]): Map<string, RuntimeEntry[]> {
  const collectionMap = new Map<string, RuntimeEntry[]>();
  for (const entry of entries) {
    const items = collectionMap.get(entry.collection) ?? [];
    items.push(entry);
    collectionMap.set(entry.collection, items);
  }
  return collectionMap;
}

function reportValidationErrors(
  nameErrors: string[],
  termErrors: string[],
  referenceErrors: string[],
): void {
  for (const error of nameErrors) {
    console.warn(`[docks] Config error: ${error}`);
  }
  for (const error of termErrors) {
    console.warn(`[docks] Taxonomy error: ${error}`);
  }
  for (const error of referenceErrors) {
    console.warn(`[docks] Reference error: ${error}`);
  }
}

export async function runPipeline(options: PipelineOptions = {}): Promise<PipelineResult> {
  const cwd = options.cwd ?? process.cwd();
  const config = await resolveConfig(cwd, options.config);
  const cache = await createCacheManager(cwd, config.collections, options.cache);
  await cache.init();

  const files = await collect(config);
  const parseResult = await parse(files, { cache });
  reportParseErrors(parseResult.errors, config);

  const transformResult = await transform(parseResult.documents, config, { cache });
  reportTransformErrors(transformResult, config);

  const collectionMap = buildCollectionMap(transformResult.entries);
  const taxonomies = config.taxonomies ?? [];

  const nameErrors = validateUniqueNames(config.collections, taxonomies);
  const termErrors = validateTaxonomyTerms(taxonomies);
  const referenceErrors = validateReferences(collectionMap, config.collections, taxonomies);
  reportValidationErrors(nameErrors, termErrors, referenceErrors);

  const writeOptions = options.outDir !== undefined ? { outDir: options.outDir } : {};
  const writeResult = options.skipWrite
    ? { typesPath: "", typesContent: "" }
    : await write(config, writeOptions);

  await cache.flush();

  return {
    config,
    files,
    parseResult,
    transformResult,
    writeResult,
    entries: transformResult.entries,
    cacheStats: cache.getStats(),
  };
}

/**
 * Export individual stages for advanced use cases.
 */
export const pipeline = {
  config: resolveConfig,
  collect,
  parse,
  transform,
  write,
  run: runPipeline,
};
