/**
 * Stale content-hashed chunk hygiene.
 *
 * `Bun.build`'s split chunks are content-hashed (`chunk-<hash>.js`), so a new
 * build emits FRESH names and never overwrites the previous build's chunks —
 * left alone they linger in the out dir and get re-deployed forever (a dialect
 * switch, or just editing a lazy island, orphans the old ones). The build sweeps
 * them before writing the new graph. This is the pure predicate that decides
 * which files are ours to sweep — only the hashed chunks, never the fixed-name
 * entry or the prerendered HTML beside them.
 */

const CHUNK_FILE = /^chunk-[A-Za-z0-9]+\.js$/;

/** Is `name` a content-hashed split chunk this pipeline emitted (and may sweep)? */
export function isChunkFile(name: string): boolean {
  return CHUNK_FILE.test(name);
}
