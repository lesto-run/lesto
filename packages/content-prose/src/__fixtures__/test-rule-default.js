/**
 * Test custom rule using default export.
 * Flags all TODO comments.
 */
export default function(spans, file, _lineIndex) {
  const diagnostics = [];

  for (const span of spans) {
    const todoPattern = /TODO:?\s*/gi;
    let match;

    while ((match = todoPattern.exec(span.text))) {
      // Prevent infinite loop if regex matches empty string
      if (match[0].length === 0) {
        todoPattern.lastIndex++;
        continue;
      }

      const offset = span.offset + match.index;

      diagnostics.push({
        id: `todo-${offset}`,
        rule: 'custom-todo',
        message: 'Unresolved TODO found',
        file,
        offset,
        line: 1,
        column: offset + 1,
        severity: 'warning',
      });
    }
  }

  return diagnostics;
}
