/**
 * @keel/config — typed configuration loading with validation.
 *
 *   const config = loadConfig(
 *     {
 *       port: { type: "number", default: 3000 },
 *       debug: { type: "boolean", default: false },
 *       databaseUrl: { type: "string", required: true, env: "DATABASE_URL" },
 *     },
 *     process.env,
 *   );
 */

export { loadConfig } from "./config";

export { ConfigError, KeelError } from "./errors";
export type { ConfigErrorCode } from "./errors";

export type { ConfigValue, Field, FieldType, Schema } from "./types";
