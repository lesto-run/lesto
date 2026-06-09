import { humanize } from "./inflector";

import type { Attributes } from "./types";

/**
 * Validations — pure functions over attributes, no database in sight.
 *
 * A blank value fails `presence` and is skipped by every other rule (you can't
 * be too short and also required-but-absent; absence is one failure, not two).
 */

export interface ValidationRule {
  readonly presence?: boolean;
  readonly length?: { readonly min?: number; readonly max?: number; readonly is?: number };
  readonly format?: RegExp;
  readonly numericality?: boolean;
  readonly inclusion?: readonly unknown[];
}

export type ValidationRules = Record<string, ValidationRule>;

export class ValidationErrors {
  private readonly map = new Map<string, string[]>();

  add(field: string, message: string): void {
    const existing = this.map.get(field) ?? [];
    existing.push(message);
    this.map.set(field, existing);
  }

  on(field: string): readonly string[] {
    return this.map.get(field) ?? [];
  }

  get isEmpty(): boolean {
    return this.map.size === 0;
  }

  get size(): number {
    return [...this.map.values()].reduce((total, messages) => total + messages.length, 0);
  }

  /** Human-readable messages, e.g. `Title can't be blank`. */
  full(): string[] {
    return [...this.map.entries()].flatMap(([field, messages]) =>
      messages.map((message) => `${humanize(field)} ${message}`),
    );
  }
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

export function validate(rules: ValidationRules, attributes: Attributes): ValidationErrors {
  const errors = new ValidationErrors();

  for (const [field, rule] of Object.entries(rules)) {
    const value = attributes[field];

    if (isBlank(value)) {
      if (rule.presence) {
        errors.add(field, "can't be blank");
      }

      continue;
    }

    if (rule.length) {
      const length = String(value).length;
      const { min, max, is } = rule.length;

      if (min !== undefined && length < min) {
        errors.add(field, `is too short (minimum is ${min} characters)`);
      }

      if (max !== undefined && length > max) {
        errors.add(field, `is too long (maximum is ${max} characters)`);
      }

      if (is !== undefined && length !== is) {
        errors.add(field, `is the wrong length (should be ${is} characters)`);
      }
    }

    if (rule.format && !rule.format.test(String(value))) {
      errors.add(field, "is invalid");
    }

    if (rule.numericality && Number.isNaN(Number(value))) {
      errors.add(field, "is not a number");
    }

    if (rule.inclusion && !rule.inclusion.includes(value)) {
      errors.add(field, "is not included in the list");
    }
  }

  return errors;
}
