/**
 * @volo/content-query
 *
 * Tiny fluent query API for typed collections (~500 bytes minified).
 * Works on any array, not coupled to @usedocks.
 *
 * @example
 * ```typescript
 * import { query } from '@volo/content-query';
 *
 * query(posts)
 *   .where({ featured: true })
 *   .where(p => p.tags.includes('react'))
 *   .orderBy('date', 'desc')
 *   .limit(5)
 *   .get();
 *
 * query(posts).first();
 * query(posts).paginate({ page: 2, perPage: 10 });
 * ```
 */

import { validateRange } from "@volo/content-shared/validation";

/** Predicate for filtering items */
export type Predicate<T> = Partial<T> | ((item: T) => boolean);

/** Pagination options */
export interface PaginateOptions {
  page: number;
  perPage: number;
}

/** Paginated result */
export interface PaginatedResult<T> {
  items: T[];
  page: number;
  perPage: number;
  totalPages: number;
  total: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/** Navigation context for prev/next navigation */
export interface PaginationContext<T> {
  /** Previous item in the collection, or undefined if this is the first */
  prev: T | undefined;
  /** Next item in the collection, or undefined if this is the last */
  next: T | undefined;
  /** 0-based index of the current item */
  index: number;
  /** Total number of items in the collection */
  total: number;
  /** Whether there is a previous item */
  hasPrev: boolean;
  /** Whether there is a next item */
  hasNext: boolean;
}

/** Query builder for typed collections */
export interface QueryBuilder<T> {
  /** Filter items matching predicate (object partial match or function) */
  where(predicate: Predicate<T>): QueryBuilder<T>;

  /** Sort by a key (ascending or descending) */
  orderBy<K extends keyof T>(key: K, direction?: "asc" | "desc"): QueryBuilder<T>;

  /** Limit the number of results */
  limit(n: number): QueryBuilder<T>;

  /** Skip the first n results */
  offset(n: number): QueryBuilder<T>;

  /** Get all matching items */
  get(): T[];

  /** Get the first matching item (or undefined) */
  first(): T | undefined;

  /** Get paginated results (page-based pagination) */
  paginate(options: PaginateOptions): PaginatedResult<T>;

  /**
   * Get pagination context for a specific item (prev/next navigation).
   * Useful for building "Previous" and "Next" links on detail pages.
   *
   * @param current - The current item, or a predicate to find it
   * @returns Pagination context with prev/next items, or undefined if item not found
   *
   * @example
   * ```typescript
   * // Using the item directly
   * const ctx = query(docs).orderBy('order').pagination(currentDoc);
   *
   * // Using a predicate
   * const ctx = query(docs).orderBy('order').pagination(d => d.slug === 'intro');
   *
   * if (ctx?.hasPrev) {
   *   console.log('Previous:', ctx.prev.title);
   * }
   * ```
   */
  pagination(current: T | ((item: T) => boolean)): PaginationContext<T> | undefined;

  /** Count matching items */
  count(): number;

  /** Check if any items match */
  exists(): boolean;
}

function matchesPredicate<T>(item: T, predicate: Predicate<T>): boolean {
  // Handle null/undefined predicates - match all items
  if (predicate == null) return true;
  if (typeof predicate === "function") {
    return predicate(item);
  }
  for (const key in predicate) {
    if (Object.prototype.hasOwnProperty.call(predicate, key)) {
      const itemVal = item[key as keyof T];
      const predVal = predicate[key as keyof T];
      if (itemVal !== predVal) return false;
    }
  }
  return true;
}

function createBuilder<T>(items: T[]): QueryBuilder<T> {
  let filtered = items;
  let limitVal: number | undefined;
  let offsetVal = 0;

  const builder: QueryBuilder<T> = {
    where(predicate) {
      filtered = filtered.filter((item) => matchesPredicate(item, predicate));
      return builder;
    },

    orderBy(key, direction = "asc") {
      // Capture original indices for stable sort (tie-breaker for equal values)
      const indexed = filtered.map((item, originalIndex) => ({ item, originalIndex }));
      indexed.sort((a, b) => {
        const aVal = a.item[key];
        const bVal = b.item[key];
        if (aVal === bVal) return a.originalIndex - b.originalIndex; // Stable tie-breaker
        if (aVal === undefined || aVal === null) return 1;
        if (bVal === undefined || bVal === null) return -1;
        const cmp = aVal < bVal ? -1 : 1;
        return direction === "desc" ? -cmp : cmp;
      });
      filtered = indexed.map(({ item }) => item);
      return builder;
    },

    limit(n) {
      validateRange(n, 0, Number.MAX_SAFE_INTEGER, "limit");
      limitVal = n;
      return builder;
    },

    offset(n) {
      validateRange(n, 0, Number.MAX_SAFE_INTEGER, "offset");
      offsetVal = n;
      return builder;
    },

    get() {
      const start = offsetVal;
      const end = limitVal !== undefined ? start + limitVal : undefined;
      return filtered.slice(start, end);
    },

    first() {
      return filtered[offsetVal];
    },

    paginate({ page, perPage }) {
      validateRange(page, 1, Number.MAX_SAFE_INTEGER, "page");
      validateRange(perPage, 1, Number.MAX_SAFE_INTEGER, "perPage");
      const total = filtered.length;
      const totalPages = Math.ceil(total / perPage);
      const validPage = Math.max(1, Math.min(page, totalPages || 1));
      const start = (validPage - 1) * perPage;
      const pageItems = filtered.slice(start, start + perPage);

      return {
        items: pageItems,
        page: validPage,
        perPage,
        totalPages,
        total,
        hasNext: validPage < totalPages,
        hasPrev: validPage > 1,
      };
    },

    pagination(current) {
      // Find the index of the current item
      const findPredicate: (item: T) => boolean =
        typeof current === "function"
          ? (current as (item: T) => boolean)
          : (item: T) => item === current;
      const index = filtered.findIndex(findPredicate);

      // Return undefined if item not found
      if (index === -1) return undefined;

      const total = filtered.length;
      return {
        prev: index > 0 ? filtered[index - 1] : undefined,
        next: index < total - 1 ? filtered[index + 1] : undefined,
        index,
        total,
        hasPrev: index > 0,
        hasNext: index < total - 1,
      };
    },

    count() {
      // Avoid array allocation by calculating count directly
      const start = offsetVal;
      const end = limitVal !== undefined ? start + limitVal : filtered.length;
      return Math.max(0, Math.min(end, filtered.length) - start);
    },

    exists() {
      // Consistent with count() - considers both offset and limit
      return builder.count() > 0;
    },
  };

  return builder;
}

/**
 * Create a query builder for a typed collection.
 *
 * @param items - Array of items to query
 * @returns Fluent query builder
 */
export function query<T>(items: T[]): QueryBuilder<T> {
  return createBuilder([...items]);
}

export default query;
