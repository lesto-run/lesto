/**
 * Test custom rule using named export.
 * Flags all FIXME comments.
 */
export function rule(spans, file, _lineIndex) {
  const diagnostics = [];

  for (const span of spans) {
    const fixmePattern = /FIXME:?\s*/gi;
    let match;

    while ((match = fixmePattern.exec(span.text))) {
      // Prevent infinite loop if regex matches empty string
      if (match[0].length === 0) {
        fixmePattern.lastIndex++;
        continue;
      }

      const offset = span.offset + match.index;

      diagnostics.push({
        id: `fixme-${offset}`,
        rule: 'custom-fixme',
        message: 'Unresolved FIXME found',
        file,
        offset,
        line: 1,
        column: offset + 1,
        severity: 'error',
      });
    }
  }

  return diagnostics;
}
