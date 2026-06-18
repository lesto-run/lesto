export const IMPORT_MARKER = Symbol.for("@volo/content-core/import");

export interface ImportReference {
  [IMPORT_MARKER]: true;
  path: string;
  name?: undefined;
}

export interface NamedImportReference {
  [IMPORT_MARKER]: true;
  path: string;
  name: string;
}

export type AnyImportReference = ImportReference | NamedImportReference;

export function createImport(path: string): ImportReference {
  return {
    [IMPORT_MARKER]: true,
    path,
  };
}

export function createNamedImport(name: string, path: string): NamedImportReference {
  return {
    [IMPORT_MARKER]: true,
    path,
    name,
  };
}

export function isImportReference(value: unknown): value is AnyImportReference {
  return (
    typeof value === "object" &&
    value !== null &&
    IMPORT_MARKER in value &&
    (value as Record<symbol, unknown>)[IMPORT_MARKER] === true
  );
}

export interface CollectedImport {
  varName: string;
  path: string;
  name: string | undefined;
}

export class ImportCollector {
  private imports: Map<string, CollectedImport> = new Map();
  private counter = 0;

  getVarName(ref: AnyImportReference): string {
    const key = ref.name ? `${ref.path}:${ref.name}` : `${ref.path}:default`;

    if (this.imports.has(key)) {
      return this.imports.get(key)!.varName;
    }

    const varName = `__v_${this.counter++}`;
    this.imports.set(key, {
      varName,
      path: ref.path,
      name: ref.name,
    });

    return varName;
  }

  getImports(): CollectedImport[] {
    return Array.from(this.imports.values());
  }

  hasImports(): boolean {
    return this.imports.size > 0;
  }

  generateImportStatements(): string {
    const statements: string[] = [];

    for (const imp of this.imports.values()) {
      if (imp.name) {
        statements.push(`import { ${imp.name} as ${imp.varName} } from "${imp.path}";`);
      } else {
        statements.push(`import ${imp.varName} from "${imp.path}";`);
      }
    }

    return statements.join("\n");
  }
}
