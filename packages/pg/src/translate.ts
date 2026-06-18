/**
 * Translate SQLite-style positional `?` placeholders to Postgres `$1..$n`.
 *
 * `@volo/db` and `@volo/migrate` emit `?` for every bound value (and ONLY for
 * bound values — identifiers are quoted, never interpolated from user input).
 * Postgres binds `$1`, `$2`, … instead, so the adapter rewrites the text once,
 * left to right, when a statement is prepared.
 *
 * A `?` inside a single-quoted string literal OR a double-quoted identifier is
 * left untouched — defensive, since Volo never puts a literal `?` in either, but
 * it keeps the translator honest if a hand-written `db.exec` ever does. An escaped
 * quote (`''` in a string, `""` in an identifier) toggles its flag twice, so the
 * surrounding state is preserved. The two flags guard each other: a `"` inside a
 * string and a `'` inside an identifier are ordinary characters, not delimiters.
 */
export function translate(sql: string): string {
  let out = "";
  let index = 0;
  let inString = false;
  let inIdent = false;

  for (const char of sql) {
    if (char === "'" && !inIdent) {
      inString = !inString;
    } else if (char === '"' && !inString) {
      inIdent = !inIdent;
    }

    if (char === "?" && !inString && !inIdent) {
      index += 1;
      out += `$${index}`;
    } else {
      out += char;
    }
  }

  return out;
}
