"use client";

import React, { useMemo, type ComponentType } from "react";
import * as ReactDOM from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import { CodeBlock } from "./CodeBlock";

/** Generic component type for MDX components */
type MDXComponent = ComponentType<Record<string, unknown>>;

export interface MDXContentProps {
  /**
   * Bundled MDX code from compileMDX result
   */
  code: string;

  /**
   * Custom components for MDX rendering.
   * By default, `pre` is mapped to CodeBlock for copy functionality.
   */
  components?: Record<string, MDXComponent>;

  /**
   * Scope variables available in MDX content
   */
  globals?: Record<string, unknown>;

  /**
   * Class name for wrapper div
   */
  className?: string;
}

/**
 * Evaluate bundled MDX code and return the component.
 */
function getMDXComponent(code: string, globals?: Record<string, unknown>) {
  const scope = {
    React,
    ReactDOM,
    _jsx_runtime: jsxRuntime,
    ...globals,
  };
  const fn = new Function(...Object.keys(scope), code);
  const result = fn(...Object.values(scope)) as {
    default: ComponentType<{ components?: Record<string, MDXComponent> }>;
  };
  return result.default;
}

/**
 * Render compiled MDX content with proper React components.
 *
 * By default, code blocks use the CodeBlock component which provides
 * copy-to-clipboard with proper React event handling (no onclick strings).
 *
 * @example
 * ```tsx
 * import { compileMDX } from '@lesto/content-mdx';
 * import { MDXContent } from '@lesto/content-mdx/components';
 *
 * const result = await compileMDX({ source: mdxString });
 *
 * function Page() {
 *   return <MDXContent code={result.code} />;
 * }
 * ```
 */
export function MDXContent({ code, components, globals, className }: MDXContentProps) {
  // Memoize component creation to avoid expensive new Function() call on every render
  const Component = useMemo(() => getMDXComponent(code, globals), [code, globals]);

  // Merge default components (CodeBlock for pre) with user-provided ones
  const mergedComponents = useMemo(
    () => ({
      pre: CodeBlock,
      ...components,
    }),
    [components],
  );

  return (
    <div className={className}>
      <Component components={mergedComponents} />
    </div>
  );
}
