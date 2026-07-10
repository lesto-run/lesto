/**
 * Stand-ins for the three `@lesto/*` modules `synthesizeEntry` unconditionally imports
 * (`@lesto/ui`, `@lesto/ui/client`, `@lesto/observability/rum`). Neither is a dependency
 * of `@lesto/island-dev`, so the optimize-deps integration test aliases them here to keep
 * the entry resolvable. Nothing is ever EXECUTED — the test only transforms modules — so
 * these need only exist and export the right names.
 */

export class Registry {
  defineClient(): this {
    return this;
  }
}

export function hydrateDocumentIslands(): unknown {
  return undefined;
}

export function enableDevPageRefresh(): void {
  // no-op
}

export function startBrowserRum(): void {
  // no-op
}
