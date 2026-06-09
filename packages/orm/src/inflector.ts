/**
 * Just enough inflection to power the ORM's conventions
 * (`BlogPost` → table `blog_posts`), tested rule by rule.
 */

const IRREGULAR: ReadonlyArray<readonly [string, string]> = [
  ["person", "people"],
  ["child", "children"],
];

const UNCOUNTABLE = new Set(["equipment", "information", "series"]);

export function pluralize(word: string): string {
  const lower = word.toLowerCase();

  if (UNCOUNTABLE.has(lower)) {
    return word;
  }

  for (const [singular, plural] of IRREGULAR) {
    if (lower === singular) {
      return plural;
    }
  }

  if (/(s|x|z|ch|sh)$/.test(word)) {
    return `${word}es`;
  }

  if (/[^aeiou]y$/.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }

  return `${word}s`;
}

export function singularize(word: string): string {
  const lower = word.toLowerCase();

  if (UNCOUNTABLE.has(lower)) {
    return word;
  }

  for (const [singular, plural] of IRREGULAR) {
    if (lower === plural) {
      return singular;
    }
  }

  if (/[^aeiou]ies$/.test(word)) {
    return `${word.slice(0, -3)}y`;
  }

  if (/(s|x|z|ch|sh)es$/.test(word)) {
    return word.slice(0, -2);
  }

  if (word.endsWith("s")) {
    return word.slice(0, -1);
  }

  return word;
}

/** `BlogPost` → `blog_post` */
export function underscore(word: string): string {
  return word
    .replaceAll(/([a-z\d])([A-Z])/g, "$1_$2")
    .replaceAll(/[-\s]+/g, "_")
    .toLowerCase();
}

/** `blog_post` / `blog-post` → `BlogPost` */
export function camelize(word: string): string {
  return word
    .replaceAll(/[_-]+(.)?/g, (_match, char: string | undefined) =>
      char ? char.toUpperCase() : "",
    )
    .replace(/^(.)/, (char) => char.toUpperCase());
}

/** Class name → table name. `BlogPost` → `blog_posts` */
export function tableize(word: string): string {
  return pluralize(underscore(word));
}

/** `created_at` / `title` → `Created at` / `Title` */
export function humanize(word: string): string {
  const spaced = underscore(word).replace(/_id$/, "").replaceAll("_", " ");

  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
