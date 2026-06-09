export interface SerializationIssue {
  path: string;
  type: "function" | "symbol" | "bigint" | "circular" | "undefined";
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: SerializationIssue[];
}

type IssueType = SerializationIssue["type"];

/** Handler registry for non-serializable primitive types - per AGENTS.md pattern */
const PRIMITIVE_ISSUE_HANDLERS: Record<
  string,
  { type: IssueType; message: (path: string) => string }
> = {
  function: { type: "function", message: (p) => `Function at "${p}" is not serializable` },
  symbol: { type: "symbol", message: (p) => `Symbol at "${p}" is not serializable` },
  bigint: {
    type: "bigint",
    message: (p) => `BigInt at "${p}" is not serializable. Convert to string or number first`,
  },
  undefined: {
    type: "undefined",
    message: (p) => `undefined at "${p}" will be omitted during serialization`,
  },
};

/** Check and report primitive type serialization issues */
function checkPrimitiveType(type: string, path: string, issues: SerializationIssue[]): boolean {
  const handler = PRIMITIVE_ISSUE_HANDLERS[type];
  if (handler) {
    issues.push({ path, type: handler.type, message: handler.message(path) });
    return true;
  }
  return false;
}

/** Validate object value recursively */
function validateObjectValue(
  value: object,
  path: string,
  seen: WeakSet<object>,
  issues: SerializationIssue[],
): boolean {
  if (seen.has(value)) {
    issues.push({ path, type: "circular", message: `Circular reference detected at "${path}"` });
    return false;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, i) => validateValue(item, `${path}[${i}]`, seen, issues));
    return true;
  }

  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return true;
  }

  for (const key of Object.keys(value)) {
    const propPath = path ? `${path}.${key}` : key;
    validateValue((value as Record<string, unknown>)[key], propPath, seen, issues);
  }

  return true;
}

function validateValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  issues: SerializationIssue[],
): boolean {
  if (value === null) return true;

  const type = typeof value;
  if (checkPrimitiveType(type, path, issues)) return true;
  if (type !== "object") return true;
  if (value instanceof Date) return true;

  return validateObjectValue(value as object, path, seen, issues);
}

export function validateSerializable(value: unknown): ValidationResult {
  const issues: SerializationIssue[] = [];
  const seen = new WeakSet<object>();

  validateValue(value, "", seen, issues);

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function hasCriticalIssues(result: ValidationResult): boolean {
  return result.issues.some((issue) => issue.type !== "undefined");
}

export function formatSerializationIssues(issues: SerializationIssue[]): string {
  return issues.map((issue) => `  - ${issue.message}`).join("\n");
}
