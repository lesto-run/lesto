/**
 * The managed-region primitive — how a generated artifact (`AGENTS.md`) is written
 * into a file WITHOUT clobbering what a human wrote around it.
 *
 * The generated content lives between two HTML-comment markers; everything outside
 * them is the author's, and {@link mergeManagedRegion} only ever rewrites what is
 * between them. This is the same "own a region, leave the rest alone" discipline a
 * Prettier-ignore block or a Terraform-managed section uses, and it is what lets
 * `lesto generate agents` be safe to re-run: re-merging the same generated content
 * is a byte-for-byte no-op ({@link isManagedRegionStale} returns false), so the
 * `--check` drift guard (Inc 4) only fires on a REAL convention change.
 *
 * A file whose markers are duplicated or unbalanced is refused with a coded
 * `CLI_AGENTS_MARKER_MALFORMED` rather than guessed at — silently picking one of
 * two regions to overwrite is exactly the data-loss this primitive exists to avoid.
 */

import { CliError } from "../errors";

/** Opens the generated region. Content between this and {@link MANAGED_REGION_END} is owned by the generator. */
export const MANAGED_REGION_START = "<!-- lesto:generated -->";

/** Closes the generated region. */
export const MANAGED_REGION_END = "<!-- /lesto:generated -->";

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;

  for (
    let idx = haystack.indexOf(needle);
    idx !== -1;
    idx = haystack.indexOf(needle, idx + needle.length)
  ) {
    count += 1;
  }

  return count;
}

/** Wrap generated inner content in the managed-region markers (each on its own line). */
function wrap(inner: string): string {
  return `${MANAGED_REGION_START}\n${inner}\n${MANAGED_REGION_END}`;
}

/**
 * Merge freshly-generated `inner` content into `existing`, rewriting ONLY the
 * managed region and preserving every byte the author wrote outside it.
 *
 *   - No markers yet (first run): keep any hand-written preamble and append the
 *     managed block after it (a lone blank line between them); an empty file just
 *     gets the block.
 *   - Exactly one marker pair: replace what is between them, keeping the text
 *     before the start and after the end verbatim.
 *   - Anything else — a duplicate marker, or only one of the pair — is malformed:
 *     throw `CLI_AGENTS_MARKER_MALFORMED` rather than risk clobbering the wrong span.
 *
 * Idempotent by construction: the output always carries exactly one marker pair,
 * so merging the same `inner` again finds that pair and rewrites it with identical
 * bytes.
 */
export function mergeManagedRegion(existing: string, inner: string): string {
  const starts = countOccurrences(existing, MANAGED_REGION_START);
  const ends = countOccurrences(existing, MANAGED_REGION_END);

  // First generation: no managed region exists yet.
  if (starts === 0 && ends === 0) {
    const preamble = existing.trimEnd();

    return preamble.length === 0 ? `${wrap(inner)}\n` : `${preamble}\n\n${wrap(inner)}\n`;
  }

  // A well-formed file has exactly one of each marker; anything else is ambiguous.
  if (starts !== 1 || ends !== 1) {
    throw new CliError(
      "CLI_AGENTS_MARKER_MALFORMED",
      "the managed region is malformed: expected exactly one start and one end marker",
      { starts, ends },
    );
  }

  const startIdx = existing.indexOf(MANAGED_REGION_START);
  const endIdx = existing.indexOf(MANAGED_REGION_END);

  // The end marker must follow the start — an inverted pair is malformed too.
  if (endIdx < startIdx) {
    throw new CliError(
      "CLI_AGENTS_MARKER_MALFORMED",
      "the managed region is malformed: the end marker precedes the start marker",
      { startIdx, endIdx },
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
