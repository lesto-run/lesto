import { sanitizeHtml } from "@volo/content-shared/sanitize";

export interface HtmlContentProps {
  html: string;
  className?: string;
  /** Skip sanitization - DANGEROUS. Only use with trusted content. */
  unsanitized?: boolean;
}

/**
 * Renders pre-rendered HTML content.
 *
 * By default, HTML is sanitized using DOMPurify to prevent XSS attacks.
 * For custom React components in content, use MDX instead of markdown.
 * MDX content is handled by MDXContent which properly supports components.
 */
export function HtmlContent({ html, className, unsanitized = false }: HtmlContentProps) {
  if (typeof html !== "string") {
    if (process.env.NODE_ENV !== "production") {
      console.error("HtmlContent: `html` prop must be a string, received:", typeof html);
    }
    return null;
  }
  const safeHtml = unsanitized ? html : sanitizeHtml(html);
  return <div className={className} dangerouslySetInnerHTML={{ __html: safeHtml }} />;
}
