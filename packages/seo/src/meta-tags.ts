import { escape } from "./escape";

/** The inputs to a document's `<head>` SEO block. Only `title` is required. */
export interface MetaTagsInput {
  title: string;
  description?: string;
  canonical?: string;
  image?: string;
  type?: string;
}

/**
 * Build the `<title>` + `<meta>` block for a page's `<head>`.
 *
 * Every value is HTML-escaped. Optional inputs that are absent contribute no
 * tag at all — we never emit an empty `content=""` placeholder, because a
 * missing tag and an empty tag mean different things to a crawler.
 */
export function metaTags(input: MetaTagsInput): string {
  const lines: string[] = [`<title>${escape(input.title)}</title>`];

  lines.push(metaProperty("og:title", input.title));

  if (input.description !== undefined) {
    lines.push(metaName("description", input.description));
    lines.push(metaProperty("og:description", input.description));
  }

  if (input.image !== undefined) {
    lines.push(metaProperty("og:image", input.image));
  }

  if (input.type !== undefined) {
    lines.push(metaProperty("og:type", input.type));
  }

  if (input.canonical !== undefined) {
    lines.push(`<link rel="canonical" href="${escape(input.canonical)}" />`);
  }

  return lines.join("\n");
}

function metaName(name: string, content: string): string {
  return `<meta name="${escape(name)}" content="${escape(content)}" />`;
}

function metaProperty(property: string, content: string): string {
  return `<meta property="${escape(property)}" content="${escape(content)}" />`;
}
