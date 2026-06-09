import GithubSlugger from "github-slugger";

/**
 * Create a new slugger instance.
 * Use for generating unique slugs when processing multiple headings.
 */
export function createSlugger(): GithubSlugger {
  return new GithubSlugger();
}

/**
 * Generate a slug from text.
 * Handles duplicate slugs automatically when using the same slugger instance.
 */
export function slugify(text: string, slugger?: GithubSlugger): string {
  const s = slugger ?? new GithubSlugger();
  return s.slug(text);
}

/**
 * Generate a slug without tracking duplicates.
 * Use when you know each call is independent.
 */
export function slugifyOnce(text: string): string {
  const slugger = new GithubSlugger();
  return slugger.slug(text);
}

/**
 * Reset a slugger's duplicate tracking.
 */
export function resetSlugger(slugger: GithubSlugger): void {
  slugger.reset();
}
