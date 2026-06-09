/**
 * Render a JSON-LD structured-data block as a ready-to-embed `<script>`.
 *
 * The payload is the caller's `data` framed by the two fields every schema.org
 * document needs: `@context` and `@type`. We serialize with `JSON.stringify`,
 * then neutralize `<` so a value containing the literal `</script>` can never
 * break out of the surrounding element — the standard hardening for inline
 * JSON in HTML.
 */
export function jsonLd(type: string, data: Record<string, unknown>): string {
  const document = {
    "@context": "https://schema.org",
    "@type": type,
    ...data,
  };

  const json = JSON.stringify(document).replaceAll("<", "\\u003c");

  return `<script type="application/ld+json">${json}</script>`;
}
