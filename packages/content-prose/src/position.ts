/**
 * Pre-computed line offsets for fast offset-to-position lookups.
 * Call createLineIndex once per file, then use offsetToPositionFast for O(log n) lookups.
 */
export interface LineIndex {
  lineStarts: number[];
}

/**
 * Create a line index for a source string.
 * This should be called once per file.
 */
export function createLineIndex(source: string): LineIndex {
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      lineStarts.push(i + 1);
    } else if (source[i] === '\r') {
      if (source[i + 1] === '\n') {
        i++; // Skip \r\n as single newline
      }
      lineStarts.push(i + 1);
    }
  }
  return { lineStarts };
}

/**
 * Fast O(log n) offset to position using binary search.
 */
export function offsetToPositionFast(index: LineIndex, offset: number): { line: number; column: number } {
  const { lineStarts } = index;

  // Binary search for the line containing this offset
  let low = 0;
  let high = lineStarts.length - 1;

  while (low < high) {
    const mid = Math.ceil((low + high + 1) / 2);
    const midStart = lineStarts[mid];
    if (midStart !== undefined && midStart <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const lowStart = lineStarts[low] ?? 0;
  return {
    line: low + 1, // 1-indexed
    column: offset - lowStart + 1, // 1-indexed
  };
}

/**
 * Legacy function for backwards compatibility.
 * @deprecated Use createLineIndex + offsetToPositionFast for better performance
 */
export function offsetToPosition(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const lines = before.split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return {
    line: lines.length,
    column: lastLine.length + 1,
  };
}
