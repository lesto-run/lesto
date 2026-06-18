import { sanitizeJsonLd } from "@volo/content-shared/sanitize";

/**
 * Component for rendering JSON-LD structured data.
 *
 * @example
 * ```tsx
 * import { JsonLd } from '@volo/content-components/react';
 * import { jsonLd } from '@volo/content-seo';
 *
 * function PostPage({ post }) {
 *   return (
 *     <>
 *       <JsonLd json={jsonLd.blogPost(post, options)} />
 *       <article>...</article>
 *     </>
 *   );
 * }
 * ```
 */
export interface JsonLdProps {
  /** JSON-LD string to render */
  json: string;
}

export function JsonLd({ json }: JsonLdProps) {
  if (typeof json !== "string") {
    if (process.env.NODE_ENV !== "production") {
      console.error("JsonLd: `json` prop must be a string, received:", typeof json);
    }
    return null;
  }

  let safeJson: string;
  try {
    safeJson = sanitizeJsonLd(json);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("JsonLd: Invalid JSON provided:", error);
    }
    return null;
  }

  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJson }} />;
}
