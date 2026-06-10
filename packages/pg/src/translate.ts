/**
 * Translate SQLite-style positional `?` placeholders to Postgres `$1..$n`.
 *
 * `@keel/db` and `@keel/migrate` emit `?` for every bound value (and ONLY for
 * bound values — identifiers are quoted, never interpolated from user input).
 * Postgres binds `$1`, `$2`, … instead, so the adapter rewrites the text once,
 * left to right, when a statement is prepared.
 *
 * A `?` inside a single-quoted SQL string literal is left untouched — defensive,
 * since Keel never puts a literal `?` in emitted SQL, but it keeps the translator
 * honest if a hand-written `db.exec` ever does. `''` (an escaped quote inside a
 * string) toggles the in-string flag twice, so the surrounding state is preserved.
 */
export function translate(sql: string): string {
  let out = "";
  let index = 0;
  let inString = false;

  for (const char of sql) {
    if (char === "'") {
      inString = !inString;
    }

    if (char === "?" && !inString) {
      index += 1;
      out += `$${index}`;
    } else {
      out += char;
    }
  }

  return out;
}
