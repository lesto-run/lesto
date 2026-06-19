import { z } from "zod";
import { ValidationError } from "./errors.js";

/**
 * Validate and normalize a URL.
 */
export function validateUrl(url: string, context = "URL"): URL {
  try {
    return new URL(url);
  } catch {
    throw new ValidationError(`Invalid ${context}: ${url}`, { url, context });
  }
}

/**
 * Zod schema for pagination parameters.
 */
export const paginationSchema = z.object({
  limit: z.number().int().min(0).max(1000).default(10),
  offset: z.number().int().min(0).default(0),
  page: z.number().int().min(1).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
});

export type PaginationParams = z.infer<typeof paginationSchema>;

/**
 * Validate pagination parameters.
 */
export function validatePagination(params: unknown): PaginationParams {
  const result = paginationSchema.safeParse(params);
  if (!result.success) {
    throw new ValidationError("Invalid pagination parameters", {
      errors: result.error.flatten(),
    });
  }
  return result.data;
}

/**
 * Zod schema for slug validation.
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format");

/**
 * Validate a slug.
 */
export function validateSlug(slug: string): string {
  const result = slugSchema.safeParse(slug);
  if (!result.success) {
    throw new ValidationError(`Invalid slug: ${slug}`, {
      slug,
      errors: result.error.flatten(),
    });
  }
  return result.data;
}

/**
 * Zod schema for npm package name validation.
 */
export const packageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/, "Invalid package name")
  .refine(
    (name) => !name.startsWith(".") && !name.startsWith("_"),
    "Package name cannot start with . or _",
  );

/**
 * Validate a content entry.
 */
export const entrySchema = z.object({
  id: z.string().min(1),
  slug: slugSchema.optional(),
  collection: z.string().min(1),
});

/**
 * Create a validator function from a Zod schema.
 */
export function createValidator<T>(schema: z.ZodType<T>, context: string): (data: unknown) => T {
  return (data: unknown) => {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ValidationError(`Invalid ${context}`, {
        context,
        errors: result.error.flatten(),
      });
    }
    return result.data;
  };
}

/**
 * Validate that a number is within a range.
 */
export function validateRange(value: number, min: number, max: number, name: string): number {
  // NaN/Infinity slip past `< min`/`> max` (every comparison with NaN is false),
  // so a NaN page would degrade to an empty slice instead of erroring. Reject
  // non-finite values up front with the same coded ValidationError.
  if (!Number.isFinite(value)) {
    throw new ValidationError(`${name} must be a finite number, got ${value}`, {
      value,
      min,
      max,
      name,
    });
  }
  if (value < min || value > max) {
    throw new ValidationError(`${name} must be between ${min} and ${max}, got ${value}`, {
      value,
      min,
      max,
      name,
    });
  }
  return value;
}

/**
 * Validate that a string is not empty.
 */
export function validateNotEmpty(value: string, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new ValidationError(`${name} cannot be empty`, { name });
  }
  return value;
}
