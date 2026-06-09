import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { InferOutput } from "./types";

/** Taxonomy schema type - same as CollectionSchema */
export type TaxonomySchema = StandardSchemaV1<Record<string, unknown>, Record<string, unknown>>;

/** Schema-based taxonomy with rich metadata per term */
export interface SchemaTaxonomyConfig<TSchema extends TaxonomySchema = TaxonomySchema> {
  name: string;
  schema: TSchema;
  terms: Array<{ slug: string } & InferOutput<TSchema>>;
}

/** Enum taxonomy with simple string terms */
export interface EnumTaxonomyConfig {
  name: string;
  terms: readonly string[];
}

/** Union of both taxonomy config types */
export type TaxonomyConfig<TSchema extends TaxonomySchema = TaxonomySchema> =
  | SchemaTaxonomyConfig<TSchema>
  | EnumTaxonomyConfig;

/** Any taxonomy config (for arrays and generic handling) */
export type AnyTaxonomy = TaxonomyConfig<TaxonomySchema>;

/** Check if taxonomy uses enum terms (string array) */
export function isEnumTaxonomy(config: AnyTaxonomy): config is EnumTaxonomyConfig {
  return !("schema" in config);
}

/** Check if taxonomy uses schema terms (objects with slug) */
export function isSchemaTaxonomy(config: AnyTaxonomy): config is SchemaTaxonomyConfig {
  return "schema" in config;
}

/** Define a schema-based taxonomy */
export function defineTaxonomy<TSchema extends TaxonomySchema>(
  config: SchemaTaxonomyConfig<TSchema>,
): SchemaTaxonomyConfig<TSchema>;
/** Define an enum taxonomy */
export function defineTaxonomy(config: EnumTaxonomyConfig): EnumTaxonomyConfig;
export function defineTaxonomy(config: AnyTaxonomy): AnyTaxonomy {
  return config;
}

/** Get all term slugs from a taxonomy */
export function getTaxonomySlugs(taxonomy: AnyTaxonomy): string[] {
  if (isEnumTaxonomy(taxonomy)) {
    return [...taxonomy.terms];
  }
  return taxonomy.terms.map((t) => t.slug);
}

/**
 * Term type returned by runtime functions.
 * Includes common fields that are frequently used in taxonomy terms.
 */
export interface TaxonomyTerm {
  slug: string;
  /** Human-readable label for the term (defaults to slug if not set) */
  label?: string;
  /** Optional description of the term */
  description?: string;
  /** Additional custom fields */
  [key: string]: unknown;
}
