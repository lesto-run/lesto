import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import DOMPurify, { type Config } from "dompurify";
import serialize from "serialize-javascript";
import { SecurityError } from "./errors.js";

// Type for DOMPurify instance (works in both browser and Node with jsdom)
type DOMPurifyInstance = ReturnType<typeof DOMPurify> | typeof DOMPurify;

// Initialize DOMPurify with jsdom for Node.js
let purifyInstance: DOMPurifyInstance | undefined;

/**
 * Resolve a DOMPurify instance backed by a real DOM, or throw if none exists.
 *
 * Three runtimes, two outcomes:
 *
 *   - Node — load `jsdom` (now a runtime DEPENDENCY, not a devDependency, so an
 *     npm consumer has it) and bind DOMPurify to a JSDOM window. We use
 *     `createRequire(import.meta.url)` rather than a bare `require`, because under
 *     native ESM (the package is `"type": "module"`) `require` is not in scope —
 *     the bare call threw `ReferenceError` for every ESM consumer.
 *   - Browser — use the global DOM directly.
 *   - No DOM (Cloudflare Workers, Deno deploy, any DOM-less runtime) — DOMPurify
 *     reports `isSupported === false` and its `sanitize` becomes a passthrough
 *     that returns the input UNCHANGED. That is the dangerous failure this guard
 *     closes: an unsanitized string flowing into HTML is an XSS hole. We THROW a
 *     coded {@link SecurityError} instead, so a no-op sanitizer fails loud rather
 *     than silently shipping attacker HTML.
 */
function resolvePurify(): DOMPurifyInstance {
  // Check for a Node runtime by probing for jsdom-able `process.versions.node`.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const isNode = typeof process !== "undefined" && process.versions?.node !== undefined;

  if (isNode) {
    // Node — bind DOMPurify to a JSDOM window. `createRequire` makes the CJS-only
    // `jsdom` loadable from an ESM module. jsdom ships no types, so the constructor
    // is read off the untyped module require (as the original bare require was).
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const { JSDOM } = require("jsdom");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
    const jsdomWindow = new JSDOM("").window;

    return DOMPurify(jsdomWindow as unknown as Parameters<typeof DOMPurify>[0]);
  }

  // Browser or DOM-less runtime — DOMPurify uses whatever global DOM exists.
  return DOMPurify;
}

/**
 * Reset the memoized DOMPurify instance. TEST-ONLY: lets a test force the
 * runtime-detection path to re-run after stubbing the global environment (e.g.
 * to simulate a DOM-less Workers runtime). Not part of the supported surface.
 */
export function resetPurifyInstanceForTest(): void {
  purifyInstance = undefined;
}

function getPurify(): DOMPurifyInstance {
  if (purifyInstance) return purifyInstance;

  const purify = resolvePurify();

  // No DOM means DOMPurify's `sanitize` is a passthrough — returning unsanitized
  // input is an XSS hole, so refuse to operate rather than fail open.
  if (!purify.isSupported) {
    // Label off the SAME signal `resolvePurify` branches on (`process.versions
    // ?.node`), not a bare `typeof process`: an edge runtime with a partial
    // `process` polyfill would otherwise be mislabeled "node". This only changes
    // the diagnostic metadata; the throw (the security behavior) is unchanged.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const isNode = typeof process !== "undefined" && process.versions?.node !== undefined;

    throw new SecurityError(
      "sanitizeHtml requires a DOM, but this runtime has none (e.g. Cloudflare Workers). " +
        "HTML cannot be safely sanitized here; sanitize before reaching the edge, or run on Node.",
      { reason: "no-dom", runtime: isNode ? "node" : "edge" },
    );
  }

  purifyInstance = purify;

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
export function sanitizeHtml(html: string, options?: Config): string {
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
export function sanitizeObject<T extends Record<string, unknown>>(obj: T): T {
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
        : item,
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
  // `node:path` is imported at the top level: the package is `"type": "module"`,
  // so a bare `require("node:path")` here threw `ReferenceError: require is not
  // defined` under native ESM (Vitest's CJS-ish loader masked it).
  const resolved = resolve(rootDir, inputPath);
  const normalizedRoot = resolve(rootDir);

  if (!resolved.startsWith(normalizedRoot + sep) && resolved !== normalizedRoot) {
    throw new SecurityError("Path traversal detected", {
      inputPath,
      rootDir,
      resolved,
    });
  }

  return resolved;
}
