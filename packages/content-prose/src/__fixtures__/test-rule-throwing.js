/**
 * Test custom rule that throws an error.
 */
export default function(_spans, _file, _lineIndex) {
  throw new Error('Intentional error for testing');
}
