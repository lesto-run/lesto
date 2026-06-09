/**
 * Convert a string to PascalCase.
 */
export function toPascalCase(str: string): string {
  if (!str) {
    return "Unnamed";
  }
  return str
    .replace(/[-_](.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

/**
 * Make a key safe for use as an object property.
 */
export function toSafeKey(key: string): string {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) {
    return key;
  }
  return JSON.stringify(key);
}

/**
 * Safely parse a date value, returning null for invalid dates.
 * Handles Date objects, strings, and numbers.
 */
export function safeParseDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
