import DOMPurify, { type Config } from "dompurify";
import serialize from "serialize-javascript";
import { SecurityError } from "./errors.js";

// Type for DOMPurify instance (works in both browser and Node with jsdom)
type DOMPurifyInstance = ReturnType<typeof DOMPurify> | typeof DOMPurify;

// Initialize DOMPurify with jsdom for Node.js
let purifyInstance: DOMPurifyInstance | undefined;

function getPurify(): DOMPurifyInstance {
  if (purifyInstance) return purifyInstance;

  // Check for browser environment by checking process.versions.node
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const isNode = typeof process !== "undefined" && process.versions?.node !== undefined;

  if (!isNode) {
    // Browser environment - use DOMPurify directly
    purifyInstance = DOMPurify;
  } else {
    // Node.js environment - lazy load jsdom
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { JSDOM } = require("jsdom");
    const jsdomWindow = new JSDOM("").window;
    // Cast through unknown for cross-environment compatibility
    purifyInstance = DOMPurify(jsdomWindow as unknown as Parameters<typeof DOMPurify>[0]);
  }

  return purifyInstance;
}

/**
 * Default DOMPurify configuration for HTML sanitization.
 */
export const DEFAULT_SANITIZE_CONFIG: Config = {
  ADD_ATTR: ["target", "rel"],
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onclick", "onload", "onmouseover"],
};

/**
 * Sanitize HTML content to prevent XSS attacks.
 * Use for all user-generated or markdown-rendered HTML.
 */
export function sanitizeHtml(
  html: string,
  options?: Config
): string {
  const purify = getPurify();
  const result = purify.sanitize(html, {
    ...DEFAULT_SANITIZE_CONFIG,
    ...options,
  });
  // DOMPurify returns string or TrustedHTML; we want string
  return typeof result === "string" ? result : String(result);
}

/**
 * Check if HTML contains potentially dangerous content.
 * Returns true if sanitization would modify the content.
 */
export function isDangerousHtml(html: string): boolean {
  const sanitized = sanitizeHtml(html);
  return sanitized !== html;
}

/**
 * Escape content for safe injection into <script type="application/ld+json">
 * Prevents XSS via </script> injection.
 */
export function sanitizeJsonLd(json: string): string {
  try {
    const parsed = JSON.parse(json);
    return serializeJsonLd(parsed);
  } catch (e) {
    throw new SecurityError("Invalid JSON for JSON-LD", {
      originalError: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Serialize an object to safe JSON-LD string.
 * Escapes characters that could break out of script tags.
 */
export function serializeJsonLd(obj: unknown): string {
  return JSON.stringify(obj, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Sanitize an object to prevent prototype pollution.
 * Recursively removes __proto__, constructor, and prototype keys.
 * Preserves Date, RegExp, and other safe built-in types.
 */
export function sanitizeObject<T extends Record<string, unknown>>(
  obj: T
): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  // Preserve safe built-in types
  if (obj instanceof Date || obj instanceof RegExp) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) =>
      typeof item === "object" && item !== null
        ? sanitizeObject(item as Record<string, unknown>)
        : item
    ) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const value = obj[key];
    result[key] =
      typeof value === "object" && value !== null
        ? sanitizeObject(value as Record<string, unknown>)
        : value;
  }

  return result as T;
}

/**
 * Serialize JavaScript safely for embedding in HTML.
 * Uses serialize-javascript to handle all edge cases.
 */
export function serializeJavaScript(obj: unknown): string {
  return serialize(obj, { isJSON: true });
}

/**
 * Validate and normalize a path to prevent path traversal.
 */
export function sanitizePath(inputPath: string, rootDir: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path");
  const resolved = path.resolve(rootDir, inputPath);
  const normalizedRoot = path.resolve(rootDir);

  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    throw new SecurityError("Path traversal detected", {
      inputPath,
      rootDir,
      resolved,
    });
  }

  return resolved;
}
