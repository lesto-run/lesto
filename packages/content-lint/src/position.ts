/**
 * Position Utilities
 *
 * Pre-computed line offsets for fast offset-to-position lookups.
 */

import type { LineIndex } from "./types.js";

/**
 * Create a line index for a source string.
 * This should be called once per file.
 */
export function createLineIndex(source: string): LineIndex {
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      lineStarts.push(i + 1);
    } else if (source[i] === "\r") {
      if (source[i + 1] === "\n") {
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
export function offsetToPositionFast(
  index: LineIndex,
  offset: number,
): { line: number; column: number } {
  const { lineStarts } = index;

  // Bounds checking: handle edge cases gracefully
  if (offset < 0) {
    return { line: 1, column: 1 };
  }

  // Handle empty line index
  if (lineStarts.length === 0) {
    return { line: 1, column: Math.max(1, offset + 1) };
  }

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
