/**
 * Example: Using Content References in Docks
 *
 * This example demonstrates how to use the reference() helper to create
 * relationships between content entries with build-time validation.
 */

import { z } from "zod";
import { defineCollection, reference } from "@lesto/content-core";

// Define an authors collection
const authors = defineCollection({
  name: "authors",
  directory: "content/authors",
  schema: z.object({
    name: z.string(),
    email: z.string().email(),
    bio: z.string().optional(),
  }),
});

// Define a posts collection that references authors
const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  schema: z.object({
    title: z.string(),
    publishedAt: z.coerce.date(),
    // Single reference to an author
    author: reference("authors"),
    // Optional reference to a category
    category: reference("categories").optional(),
    // Array of references to related posts (max 3)
    relatedPosts: reference("posts").array().max(3).optional(),
  }),
});

// Define a categories collection
const categories = defineCollection({
  name: "categories",
  directory: "content/categories",
  schema: z.object({
    name: z.string(),
    description: z.string().optional(),
  }),
});

/**
 * Example content structure:
 *
 * content/
 *   authors/
 *     john-doe.md          # slug: "john-doe"
 *     jane-smith.md        # slug: "jane-smith"
 *   categories/
 *     web-development.md   # slug: "web-development"
 *     javascript.md        # slug: "javascript"
 *   posts/
 *     hello-world.md
 *     advanced-react.md
 *     getting-started.md
 */

/**
 * Example: content/posts/hello-world.md
 *
 * ---
 * title: Hello World
 * publishedAt: 2024-01-01
 * author: john-doe               # References authors/john-doe.md
 * category: web-development      # References categories/web-development.md
 * relatedPosts:
 *   - getting-started
 *   - advanced-react
 * ---
 *
 * This is my first post!
 */

/**
 * Build-time validation:
 *
 * The pipeline will validate:
 * 1. All referenced authors exist in the authors collection
 * 2. All referenced categories exist in the categories collection
 * 3. All related posts exist in the posts collection
 * 4. Arrays don't exceed their max length (3 in this case)
 *
 * Errors will be reported as warnings:
 * - "posts/hello-world: 'author' references non-existent authors/unknown"
 * - "Collection 'posts' references unknown collection 'tags'"
 */

export { authors, posts, categories };
