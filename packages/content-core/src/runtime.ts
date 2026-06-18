import type {
  Collection,
  CollectionEntry,
  CollectionRegistry,
  RuntimeEntry,
  TaxonomyRegistry,
  WorkflowConfig,
} from "./types";
import type { AnyTaxonomy, TaxonomyTerm } from "./taxonomy";
import { isEnumTaxonomy } from "./taxonomy";
import { safeParseDate } from "./utils";

export interface CollectionWorkflowConfig {
  [collectionName: string]: WorkflowConfig | undefined;
}

interface DataStore {
  collections: Record<string, RuntimeEntry[]> | null;
  taxonomies: Record<string, AnyTaxonomy> | null;
  workflowConfigs: CollectionWorkflowConfig | null;
}

const STORE_KEY = Symbol.for("@volo/content-core/runtime");

function getStore(): DataStore {
  const g = globalThis as unknown as Record<symbol, DataStore | undefined>;
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = { collections: null, taxonomies: null, workflowConfigs: null };
  }
  return g[STORE_KEY];
}

function loadData(): Record<string, RuntimeEntry[]> {
  const store = getStore();

  if (store.collections) return store.collections;

  throw new Error(
    "Docks: Content data not initialized. " +
      "Ensure you have imported '@volo/content-content' (or your configured content alias) " +
      "before calling getCollection/getEntry. The generated content module will " +
      "automatically initialize the runtime data when imported.",
  );
}

export function invalidateRuntimeEngine(): void {
  const store = getStore();
  store.collections = null;
  store.taxonomies = null;
  store.workflowConfigs = null;
}

/** @internal */
export function setData(collections: Record<string, RuntimeEntry[]>): void {
  const store = getStore();
  store.collections = collections;
}

/** @internal */
export function setWorkflowConfigs(configs: CollectionWorkflowConfig): void {
  const store = getStore();
  store.workflowConfigs = configs;
}

/** @internal */
export function setTaxonomies(taxonomies: Record<string, AnyTaxonomy>): void {
  const store = getStore();
  store.taxonomies = taxonomies;
}

export function getWorkflowConfig(collectionName: string): WorkflowConfig | undefined {
  const store = getStore();
  return store.workflowConfigs?.[collectionName];
}

/** Get a taxonomy definition by name */
export function getTaxonomy<K extends keyof TaxonomyRegistry>(name: K): AnyTaxonomy | undefined;
export function getTaxonomy(name: string): AnyTaxonomy | undefined;
export function getTaxonomy(name: string): AnyTaxonomy | undefined {
  const store = getStore();
  return store.taxonomies?.[name];
}

/** Get all terms for a taxonomy */
export function getTaxonomyTerms<K extends keyof TaxonomyRegistry>(name: K): TaxonomyTerm[];
export function getTaxonomyTerms(name: string): TaxonomyTerm[];
export function getTaxonomyTerms(name: string): TaxonomyTerm[] {
  const taxonomy = getTaxonomy(name);
  if (!taxonomy) return [];

  if (isEnumTaxonomy(taxonomy)) {
    return taxonomy.terms.map((term) => ({ slug: term }));
  }
  return taxonomy.terms;
}

/** Get all taxonomy definitions */
export function getTaxonomies(): AnyTaxonomy[] {
  const store = getStore();
  if (!store.taxonomies) return [];
  return Object.values(store.taxonomies);
}

/**
 * Get label for a single taxonomy term.
 * Returns the term's label if defined, otherwise returns the slug.
 */
export function getTermLabel<K extends keyof TaxonomyRegistry>(taxonomy: K, slug: string): string;
export function getTermLabel(taxonomy: string, slug: string): string;
export function getTermLabel(taxonomy: string, slug: string): string {
  const terms = getTaxonomyTerms(taxonomy);
  const term = terms.find((t) => t.slug === slug);
  if (!term) return slug;
  return term.label ?? slug;
}

/**
 * Get all labels for a taxonomy as a slug-to-label map.
 * Terms without labels will use their slug as the label.
 */
export function getTermLabels<K extends keyof TaxonomyRegistry>(
  taxonomy: K,
): Record<string, string>;
export function getTermLabels(taxonomy: string): Record<string, string>;
export function getTermLabels(taxonomy: string): Record<string, string> {
  const terms = getTaxonomyTerms(taxonomy);
  return Object.fromEntries(terms.map((t) => [t.slug, t.label ?? t.slug]));
}

export function getCollection<K extends keyof CollectionRegistry>(name: K): CollectionEntry<K>[];
export function getCollection(name: string): RuntimeEntry[];
export function getCollection(name: string): RuntimeEntry[] {
  const collections = loadData();
  let entries = collections[name] ?? [];

  const workflowConfig = getWorkflowConfig(name);
  // Default to filtering unpublished content (opt-out with filterUnpublished: false)
  if (workflowConfig && workflowConfig.filterUnpublished !== false) {
    entries = filterPublishedEntries(entries, workflowConfig);
  }

  return entries;
}

/** Check if entry passes publish date filter (true = passes, false = filtered out) */
function passesPublishDateFilter(
  entry: RuntimeEntry,
  field: string | undefined,
  now: Date,
): boolean {
  if (!field) return true;
  const publishDate = entry[field];
  if (publishDate === undefined || publishDate === null) return true;
  const pubDate = safeParseDate(publishDate);
  // Invalid dates are treated as unpublished (filtered out)
  return pubDate !== null && pubDate.getTime() <= now.getTime();
}

/** Check if entry passes expiration filter (true = passes, false = filtered out) */
function passesExpirationFilter(
  entry: RuntimeEntry,
  field: string | undefined,
  now: Date,
): boolean {
  if (!field) return true;
  const expiresAt = entry[field];
  if (expiresAt === undefined || expiresAt === null) return true;
  const expDate = safeParseDate(expiresAt);
  // Invalid expiration dates are ignored (entry stays)
  return expDate === null || expDate.getTime() > now.getTime();
}

function filterPublishedEntries(entries: RuntimeEntry[], config: WorkflowConfig): RuntimeEntry[] {
  const now = new Date();
  const { statusField, publishDateField, expirationField } = config;

  return entries.filter(
    (entry) =>
      entry[statusField] === "published" &&
      passesPublishDateFilter(entry, publishDateField, now) &&
      passesExpirationFilter(entry, expirationField, now),
  );
}

export function getEntry<K extends keyof CollectionRegistry>(
  collection: K,
  slug: string,
): CollectionEntry<K> | undefined;
export function getEntry(collection: string, slug: string): RuntimeEntry | undefined;
export function getEntry(collection: string, slug: string): RuntimeEntry | undefined {
  const collections = loadData();
  let entries = collections[collection];
  if (!entries) return undefined;

  const workflowConfig = getWorkflowConfig(collection);
  // Default to filtering unpublished content (opt-out with filterUnpublished: false)
  if (workflowConfig && workflowConfig.filterUnpublished !== false) {
    entries = filterPublishedEntries(entries, workflowConfig);
  }

  return entries.find((e) => (e as Record<string, unknown>)["slug"] === slug);
}

export function getCollections(): Collection[] {
  const collections = loadData();
  // Route through getCollection so the SAME unpublished-filtering is applied —
  // listing collections must never leak drafts that single-collection access hides.
  return Object.keys(collections).map((name) => ({
    name,
    entries: getCollection(name),
  }));
}
