/**
 * The managed-region primitive — how a generated artifact (`AGENTS.md`) is written
 * into a file WITHOUT clobbering what a human wrote around it.
 *
 * The generated content lives between two HTML-comment markers, each ALONE ON ITS
 * OWN LINE; everything outside them is the author's, and {@link mergeManagedRegion}
 * only ever rewrites what is between them. This is the same "own a region, leave the
 * rest alone" discipline a Prettier-ignore block or a Terraform-managed section uses,
 * and it is what lets `lesto generate agents` be safe to re-run: re-merging the same
 * generated content is a byte-for-byte no-op ({@link isManagedRegionStale} returns
 * false), so the `--check` drift guard (Inc 4) only fires on a REAL convention change.
 *
 * The marker match is LINE-ANCHORED, not a bare substring: a marker counts only when
 * it is the sole non-whitespace content of a line. That is what makes the region safe
 * against an author who happens to mention the marker text inside their own prose (it
 * is not a whole-line marker, so it is left untouched) and against a generated value
 * that contains a marker token (it is rendered mid-line, so it never opens a region).
 *
 * A file whose whole-line markers are duplicated or unbalanced is refused with a coded
 * `CLI_AGENTS_MARKER_MALFORMED` rather than guessed at — silently picking one of two
 * regions to overwrite is exactly the data-loss this primitive exists to avoid.
 */

import { CliError } from "../errors";

/** Opens the generated region. Content between this and {@link MANAGED_REGION_END} is owned by the generator. */
export const MANAGED_REGION_START = "<!-- lesto:generated -->";

/** Closes the generated region. */
export const MANAGED_REGION_END = "<!-- /lesto:generated -->";

/**
 * The character offsets of every line that is EXACTLY `marker` (ignoring leading and
 * trailing whitespace). Each offset points at the marker text itself (past any
 * indentation), so a caller can slice on it the way the original substring match did —
 * but a mid-line mention of the marker is never matched.
 */
function lineMarkerOffsets(source: string, marker: string): number[] {
  const offsets: number[] = [];

  let lineStart = 0;

  for (const line of source.split("\n")) {
    if (line.trim() === marker) {
      offsets.push(lineStart + (line.length - line.trimStart().length));
    }

    // +1 for the "\n" that `split` consumed between lines.
    lineStart += line.length + 1;
  }

  return offsets;
}

/** Wrap generated inner content in the managed-region markers (each on its own line). */
function wrap(inner: string): string {
  return `${MANAGED_REGION_START}\n${inner}\n${MANAGED_REGION_END}`;
}

/**
 * Merge freshly-generated `inner` content into `existing`, rewriting ONLY the
 * managed region and preserving every byte the author wrote outside it.
 *
 *   - No whole-line markers yet (first run): keep any hand-written preamble and
 *     append the managed block after it (a lone blank line between them); an empty
 *     file just gets the block. An author who merely *mentions* the marker text in
 *     prose has no whole-line marker, so they take this path — their text is kept.
 *   - Exactly one whole-line marker pair: replace what is between them, keeping the
 *     text before the start and after the end verbatim.
 *   - Anything else — a duplicated whole-line marker, one of the pair missing, or an
 *     inverted pair — is malformed: throw `CLI_AGENTS_MARKER_MALFORMED` rather than
 *     risk clobbering the wrong span.
 *
 * Idempotent by construction: the output always carries exactly one whole-line marker
 * pair, so merging the same `inner` again finds that pair and rewrites it identically.
 */
export function mergeManagedRegion(existing: string, inner: string): string {
  const startOffsets = lineMarkerOffsets(existing, MANAGED_REGION_START);
  const endOffsets = lineMarkerOffsets(existing, MANAGED_REGION_END);

  // First generation: no managed region exists yet (a bare prose mention of the
  // marker text is not a whole-line marker, so it lands here and is preserved).
  if (startOffsets.length === 0 && endOffsets.length === 0) {
    const preamble = existing.trimEnd();

    return preamble.length === 0 ? `${wrap(inner)}\n` : `${preamble}\n\n${wrap(inner)}\n`;
  }

  // A well-formed file has exactly one of each marker, start before end; anything
  // else is ambiguous and refused.
  const startIdx = startOffsets.length === 1 ? startOffsets[0] : undefined;
  const endIdx = endOffsets.length === 1 ? endOffsets[0] : undefined;

  if (startIdx === undefined || endIdx === undefined || endIdx < startIdx) {
    throw new CliError(
      "CLI_AGENTS_MARKER_MALFORMED",
      "the managed region is malformed: expected exactly one start and one end marker, each on its own line, in order",
      { starts: startOffsets.length, ends: endOffsets.length },
    );
  }

  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + MANAGED_REGION_END.length);

  return `${before}${wrap(inner)}${after}`;
}

/**
 * Whether merging `inner` into `existing` would change it — the pure core of the
 * `--check` drift guard. False means the file already carries exactly this
 * generated content (safe, re-running would no-op); true means it is stale or
 * absent and a generation is due. Propagates `CLI_AGENTS_MARKER_MALFORMED` for a
 * malformed file, so `--check` surfaces a broken region rather than masking it.
 */
export function isManagedRegionStale(existing: string, inner: string): boolean {
  return mergeManagedRegion(existing, inner) !== existing;
}
