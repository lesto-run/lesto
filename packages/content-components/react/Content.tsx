import { Component, type ReactNode, type ErrorInfo } from "react";
import { HtmlContent } from "./HtmlContent";
import { MDXContent, type MDXContentProps } from "./MDXContent";

/**
 * Minimal type for content entries - no @volo/content-core dependency needed.
 * This keeps the components package browser-safe and self-contained.
 */
export interface ContentEntry {
  rendered?: { html?: string };
  mdx?: { code: string };
}

interface MDXErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface MDXErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

/**
 * Error boundary for MDX content to prevent crashes from spreading.
 */
class MDXErrorBoundary extends Component<MDXErrorBoundaryProps, MDXErrorBoundaryState> {
  constructor(props: MDXErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): MDXErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (process.env.NODE_ENV !== "production") {
      console.error("MDX render error:", error, info);
    }
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div role="alert" style={{ color: "red", padding: "1rem" }}>
            Failed to render content
          </div>
        )
      );
    }
    return this.props.children;
  }
}

export interface ContentProps extends Omit<MDXContentProps, "code"> {
  /**
   * The entry to render
   */
  entry: ContentEntry;
  /**
   * Add anchor links to headings for easy sharing.
   * When true, adds a '#' link before each heading that links to itself.
   *
   * @default false
   */
  anchorLinks?: boolean;
}

/**
 * Check if entry has MDX code (inline check, no @volo/content-core needed)
 */
function isMDXEntry(entry: ContentEntry): entry is ContentEntry & { mdx: { code: string } } {
  return entry.mdx !== undefined && typeof entry.mdx.code === "string";
}

/**
 * Add anchor links to headings in HTML content.
 * Matches heading elements with IDs and prepends an anchor link.
 *
 * The anchor is decorative (tabindex="-1" and aria-hidden) so keyboard users
 * navigate directly to the heading, not the redundant anchor link.
 */
function addAnchorLinksToHtml(html: string): string {
  // Match headings (h1-h6) with id attributes
  // Pattern: <h[1-6][^>]*id="([^"]+)"[^>]*>
  return html.replace(
    /<(h[1-6])([^>]*)\bid=["']([^"']+)["']([^>]*)>/gi,
    (_match, tag, before, id, after) => {
      // tabindex="-1" removes from tab order, aria-hidden hides from screen readers
      const anchor = `<a href="#${id}" class="anchor" tabindex="-1" aria-hidden="true">#</a>`;
      return `<${tag}${before}id="${id}"${after}>${anchor}`;
    },
  );
}

/**
 * Unified content renderer that handles both markdown and MDX entries.
 * Automatically detects entry type and uses appropriate renderer.
 *
 * - MDX entries: Evaluates bundled code with component support
 * - Markdown entries: Renders pre-built HTML (use MDX for custom components)
 *
 * @example
 * ```tsx
 * // Basic usage
 * <Content entry={post} className="prose" />
 *
 * // With anchor links on headings
 * <Content entry={post} anchorLinks className="prose" />
 *
 * // With custom MDX components
 * <Content entry={post} components={{ Callout, CodeBlock }} />
 * ```
 */
export function Content({
  entry,
  components,
  globals,
  className,
  anchorLinks = false,
}: ContentProps) {
  // Validate entry prop
  if (!entry || typeof entry !== "object") {
    if (process.env.NODE_ENV !== "production") {
      console.error("Content: `entry` prop must be an object, received:", typeof entry);
    }
    return null;
  }

  // Handle MDX entries - supports custom components, wrapped in error boundary
  if (isMDXEntry(entry)) {
    return (
      <MDXErrorBoundary>
        <MDXContent
          code={entry.mdx.code}
          {...(components === undefined ? {} : { components })}
          {...(globals === undefined ? {} : { globals })}
          {...(className === undefined ? {} : { className })}
        />
      </MDXErrorBoundary>
    );
  }

  // Handle standard markdown entries - pre-rendered HTML
  const rendered = entry.rendered;

  if (!rendered?.html) {
    return (
      <div className={className}>
        <p>No rendered content available.</p>
      </div>
    );
  }

  // Apply anchor links transformation if enabled
  const html = anchorLinks ? addAnchorLinksToHtml(rendered.html) : rendered.html;

  return <HtmlContent html={html} {...(className === undefined ? {} : { className })} />;
}
