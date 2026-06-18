import type { RuntimeEntry, CollectionEntry, CollectionRegistry, WorkflowConfig } from "./types";
import { getCollection } from "./runtime";
import { safeParseDate } from "./utils";
import { validateRange } from "@lesto/content-shared/validation";

type WhereOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "contains";

const DEFAULT_STATUS_FIELD = "status";
const DEFAULT_PUBLISH_DATE_FIELD = "publishedAt";

interface WhereClause {
  path: string;
  op: WhereOp;
  value: unknown;
}

interface OrderByClause {
  field: string;
  dir: "asc" | "desc";
}

export interface PaginationOptions {
  page: number;
  perPage: number;
}

export interface PaginationMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface PaginatedResult<T> {
  entries: T[];
  pagination: PaginationMeta;
}

export interface QueryOptions {
  workflow?: WorkflowConfig;
}

export class Query<T extends Record<string, unknown> = RuntimeEntry> {
  private collectionName: string;
  private whereClauses: WhereClause[] = [];
  private orderByClauses: OrderByClause[] = [];
  private limitCount?: number;
  private offsetCount = 0;
  private workflowConfig: WorkflowConfig | undefined;

  constructor(collection: string, options?: QueryOptions) {
    this.collectionName = collection;
    this.workflowConfig = options?.workflow;
  }

  published(): this {
    const statusField = this.workflowConfig?.statusField ?? DEFAULT_STATUS_FIELD;
    const publishDateField = this.workflowConfig?.publishDateField ?? DEFAULT_PUBLISH_DATE_FIELD;
    const expirationField = this.workflowConfig?.expirationField;

    this.whereClauses.push({ path: statusField, op: "==", value: "published" });

    this.publishedFilter = expirationField
      ? { publishDateField, expirationField }
      : { publishDateField };

    return this;
  }

  drafts(): this {
    const statusField = this.workflowConfig?.statusField ?? DEFAULT_STATUS_FIELD;
    this.whereClauses.push({ path: statusField, op: "==", value: "draft" });
    return this;
  }

  scheduled(): this {
    const publishDateField = this.workflowConfig?.publishDateField ?? DEFAULT_PUBLISH_DATE_FIELD;
    this.scheduledFilter = { publishDateField };

    return this;
  }

  private publishedFilter?: { publishDateField: string; expirationField?: string };
  private scheduledFilter?: { publishDateField: string };

  private applyDateFilters(entries: T[]): T[] {
    const now = new Date();

    const afterPublishedFilter = this.publishedFilter
      ? entries.filter((e) => {
          const { publishDateField, expirationField } = this.publishedFilter!;
          const publishDate = getPath(e, publishDateField);
          if (publishDate !== undefined && publishDate !== null) {
            const pubDate = safeParseDate(publishDate);
            // Invalid dates are treated as unpublished (filtered out)
            if (!pubDate || pubDate.getTime() > now.getTime()) {
              return false;
            }
          }
          if (expirationField) {
            const expiresAt = getPath(e, expirationField);
            if (expiresAt !== undefined && expiresAt !== null) {
              const expDate = safeParseDate(expiresAt);
              // Invalid expiration dates are ignored (entry stays)
              if (expDate && expDate.getTime() <= now.getTime()) {
                return false;
              }
            }
          }
          return true;
        })
      : entries;

    return this.scheduledFilter
      ? afterPublishedFilter.filter((e) => {
          const { publishDateField } = this.scheduledFilter!;
          const statusField = this.workflowConfig?.statusField ?? DEFAULT_STATUS_FIELD;
          const status = getPath(e, statusField);
          if (status === "scheduled") {
            return true;
          }
          const publishDate = getPath(e, publishDateField);
          if (publishDate !== undefined && publishDate !== null) {
            const pubDate = safeParseDate(publishDate);
            // Invalid dates are treated as not scheduled
            return pubDate !== null && pubDate.getTime() > now.getTime();
          }
          return false;
        })
      : afterPublishedFilter;
  }

  where(path: string, op: WhereOp, value: unknown): this {
    this.whereClauses.push({ path, op, value });
    return this;
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): this {
    this.orderByClauses.push({ field, dir });
    return this;
  }

  limit(n: number): this {
    this.limitCount = n;
    return this;
  }

  offset(n: number): this {
    this.offsetCount = n;
    return this;
  }

  private sortEntries(entries: T[]): T[] {
    if (this.orderByClauses.length === 0) return entries;
    return entries.toSorted((a, b) => {
      for (const { field, dir } of this.orderByClauses) {
        const cmp = compare(getPath(a, field), getPath(b, field));
        if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  get(): T[] {
    // Immutable pipeline - per AGENTS.md
    const filtered = this.whereClauses.reduce(
      (acc, clause) => acc.filter((e) => this.evaluate(e, clause)),
      getCollection(this.collectionName) as T[],
    );
    const sorted = this.sortEntries(this.applyDateFilters(filtered));

    // Apply offset and limit in single slice
    const start = this.offsetCount;
    const end = this.limitCount !== undefined ? start + this.limitCount : undefined;
    return sorted.slice(start, end);
  }

  paginate(options: PaginationOptions): PaginatedResult<T> {
    const { page, perPage } = options;

    // Reject nonsensical pagination up front: page < 1 yields a negative offset
    // (wrong slice) and perPage < 1 makes totalPages = Infinity / NaN. Throw a
    // coded ValidationError, mirroring @lesto/content-query's paginate.
    validateRange(page, 1, Number.MAX_SAFE_INTEGER, "page");
    validateRange(perPage, 1, Number.MAX_SAFE_INTEGER, "perPage");

    // Immutable pipeline - per AGENTS.md
    const filtered = this.whereClauses.reduce(
      (acc, clause) => acc.filter((e) => this.evaluate(e, clause)),
      getCollection(this.collectionName) as T[],
    );
    const sorted = this.sortEntries(this.applyDateFilters(filtered));

    const total = sorted.length;
    const totalPages = Math.ceil(total / perPage);
    const offset = (page - 1) * perPage;

    return {
      entries: sorted.slice(offset, offset + perPage),
      pagination: {
        page,
        perPage,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  private evaluate(entry: T, clause: WhereClause): boolean {
    const val = getPath(entry, clause.path);
    const handler = WHERE_OP_HANDLERS[clause.op];
    return handler ? handler(val, clause.value) : true;
  }
}

/** Handler registry for where operators - per AGENTS.md pattern */
const WHERE_OP_HANDLERS: Record<WhereOp, (val: unknown, clauseVal: unknown) => boolean> = {
  "==": (val, clauseVal) => val === clauseVal,
  "!=": (val, clauseVal) => val !== clauseVal,
  "<": (val, clauseVal) => (val as number) < (clauseVal as number),
  "<=": (val, clauseVal) => (val as number) <= (clauseVal as number),
  ">": (val, clauseVal) => (val as number) > (clauseVal as number),
  ">=": (val, clauseVal) => (val as number) >= (clauseVal as number),
  in: (val, clauseVal) => (clauseVal as unknown[]).includes(val),
  contains: (val, clauseVal) => Array.isArray(val) && val.includes(clauseVal),
};

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

function compare(a: unknown, b: unknown): number {
  // Handle null/undefined - push to end
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;

  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return 0;
}

export function query<K extends keyof CollectionRegistry>(
  collection: K,
  options?: QueryOptions,
): Query<CollectionEntry<K> & Record<string, unknown>>;
export function query<T extends Record<string, unknown> = RuntimeEntry>(
  collection: string,
  options?: QueryOptions,
): Query<T>;
export function query(collection: string, options?: QueryOptions): Query<RuntimeEntry> {
  return new Query(collection, options);
}
