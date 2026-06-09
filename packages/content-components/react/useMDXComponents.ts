import { useRef, type ComponentType } from "react";

export interface ComponentRegistry {
  [name: string]: ComponentType<Record<string, unknown>>;
}

/**
 * Shallow equality check for component registries.
 */
function shallowEqual(a: ComponentRegistry, b: ComponentRegistry): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Hook to create a memoized component registry for MDX.
 * Useful when components need to be dynamically imported or merged.
 *
 * Uses shallow equality to compare registries, so inline objects work correctly.
 *
 * @param baseComponents - Base component registry to use
 * @param overrides - Component overrides to merge with base components
 * @returns Memoized merged component registry
 *
 * @example
 * ```tsx
 * const baseComponents = { Alert, CodeBlock };
 * const customComponents = { Alert: CustomAlert };
 * const components = useMDXComponents(baseComponents, customComponents);
 * // Result: { Alert: CustomAlert, CodeBlock }
 * ```
 */
export function useMDXComponents(
  baseComponents: ComponentRegistry,
  overrides: ComponentRegistry = {},
): ComponentRegistry {
  const baseRef = useRef(baseComponents);
  const overridesRef = useRef(overrides);
  const mergedRef = useRef<ComponentRegistry>({ ...baseComponents, ...overrides });

  // Check if either registry actually changed (shallow compare)
  const baseChanged = !shallowEqual(baseRef.current, baseComponents);
  const overridesChanged = !shallowEqual(overridesRef.current, overrides);

  if (baseChanged || overridesChanged) {
    if (baseChanged) baseRef.current = baseComponents;
    if (overridesChanged) overridesRef.current = overrides;
    mergedRef.current = { ...baseRef.current, ...overridesRef.current };
  }

  return mergedRef.current;
}
