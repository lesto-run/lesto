/**
 * Base error class for all Docks errors.
 * Provides structured context for debugging and logging.
 */
export class DocksError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;
  readonly timestamp: Date;

  constructor(message: string, code: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "DocksError";
    this.code = code;
    this.context = context;
    this.timestamp = new Date();

    // Maintains proper stack trace for where error was thrown
    if ("captureStackTrace" in Error) {
      (
        Error as { captureStackTrace: (target: object, constructor?: Function) => void }
      ).captureStackTrace(this, DocksError);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack,
    };
  }
}

/**
 * Validation errors for invalid input data.
 */
export class ValidationError extends DocksError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", context);
    this.name = "ValidationError";
  }
}

/**
 * Parse errors for malformed content (YAML, JSON, Markdown).
 */
export class ParseError extends DocksError {
  readonly line: number | undefined;
  readonly column: number | undefined;

  constructor(
    message: string,
    context?: Record<string, unknown> & { line?: number; column?: number },
  ) {
    super(message, "PARSE_ERROR", context);
    this.name = "ParseError";
    this.line = context?.line;
    this.column = context?.column;
  }
}

/**
 * Network errors for failed HTTP requests.
 */
export class NetworkError extends DocksError {
  readonly statusCode: number | undefined;
  readonly url: string | undefined;

  constructor(
    message: string,
    context?: Record<string, unknown> & { statusCode?: number; url?: string },
  ) {
    super(message, "NETWORK_ERROR", context);
    this.name = "NetworkError";
    this.statusCode = context?.statusCode;
    this.url = context?.url;
  }
}

/**
 * Security errors for XSS, path traversal, etc.
 */
export class SecurityError extends DocksError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "SECURITY_ERROR", context);
    this.name = "SecurityError";
  }
}

/**
 * Configuration errors for invalid config files.
 */
export class ConfigError extends DocksError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "CONFIG_ERROR", context);
    this.name = "ConfigError";
  }
}

/**
 * Result type for operations that can fail.
 * Use instead of throwing for recoverable errors.
 */
export type Result<T, E = DocksError> = { success: true; data: T } | { success: false; error: E };

export function ok<T>(data: T): Result<T, never> {
  return { success: true, data };
}

export function err<E>(error: E): Result<never, E> {
  return { success: false, error };
}

/**
 * Type guard for Result success case.
 */
export function isOk<T, E>(result: Result<T, E>): result is { success: true; data: T } {
  return result.success;
}

/**
 * Type guard for Result error case.
 */
export function isErr<T, E>(result: Result<T, E>): result is { success: false; error: E } {
  return !result.success;
}

/**
 * Unwrap a Result, throwing if it's an error.
 */
export function unwrap<T, E extends Error>(result: Result<T, E>): T {
  if (result.success) return result.data;
  throw result.error;
}

/**
 * Unwrap a Result with a default value.
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return result.success ? result.data : defaultValue;
}
