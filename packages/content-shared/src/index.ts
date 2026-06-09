// Re-export all modules
export * from "./errors.js";
export * from "./encoding.js";
export * from "./slugify.js";
export * from "./xml.js";
export * from "./sanitize.js";
export * from "./mutex.js";
export * from "./cache.js";
export * from "./validation.js";
export * from "./shutdown.js";

// Markdown utilities are async imports due to optional peer deps
export { extractPlainText, extractHeadings, stripFrontmatter, hasFrontmatter, calculateReadingTime } from "./markdown.js";
export type { Heading, ReadingTime } from "./markdown.js";
