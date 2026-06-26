/**
 * Stale content-hashed chunk hygiene — the FALLBACK net for the stale-artifact sweep.
 *
 * `Bun.build`'s split chunks are content-hashed (`chunk-<hash>.js`), so a new build
 * emits FRESH names and never overwrites the previous build's chunks — left alone
 * they linger in the out dir and get re-deployed forever (a dialect switch, or just
 * editing a lazy island, orphans the old ones). `build-client.ts` sweeps stale
 * artifacts driven primarily by the generation marker's PROVENANCE (the files this
 * pipeline previously wrote — chunks AND emitted assets alike). This predicate is the
 * fallback for orphaned JS chunks that carry NO marker provenance: a pre-marker build,
 * a deleted/corrupt marker, or a dialect switch that orphaned chunks before the marker
 * existed. It earns its place because a content-hashed chunk is recognizable by NAME
 * (the `chunk-<hash>.js` scheme this pipeline owns) even with no marker; an emitted
 * asset's extension is arbitrary, so an asset is NEVER swept by name — only by marker
 * provenance. It matches only the hashed chunks, never the fixed-name entry or the
 * prerendered HTML beside them.
 */

const CHUNK_FILE = /^chunk-[A-Za-z0-9]+\.js$/;

/** Is `name` a content-hashed split chunk this pipeline emitted (and may sweep)? */
export function isChunkFile(name: string): boolean {
  return CHUNK_FILE.test(name);
}
