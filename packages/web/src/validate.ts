/**
 * `validateBody` — validation at the request boundary, with Zod (ADR 0005).
 *
 * A controller that writes `this.request.body as { title: string }` has a cast,
 * not a check: an attacker-supplied `{ title: 1234 }` would crash the handler,
 * not return a 4xx. This helper closes that gap. It runs a Zod schema against
 * the decoded body and either returns the parsed, typed value — everything past
 * this point is trusted — or throws a coded {@link WebError} the shared error
 * boundary (`statusForError`) maps to **422 Unprocessable Entity**, on both the
 * node and edge runtimes.
 *
 *   const NewPost = z.object({ title: z.string().trim().min(1) });
 *
 *   create(): LestoResponse {
 *     const input = validateBody(NewPost, this.request); // typed { title: string }
 *     const post = insertPost(this.db, input);
 *     return this.json({ post }, 201);
 *   }
 *
 * The thrown error carries the Zod issues in `details.issues`, so a caller that
 * wants field-level reporting can catch it (or skip the helper and `safeParse`
 * directly, returning `parsed.error.flatten()` as JSON — see ADR 0005). The
 * default path is the safe one: a generic 422 body, no internals leaked.
 *
 * Per ADR 0005 the schema is Zod itself — its `safeParse` IS the validation
 * interface the JS ecosystem speaks, so there is no `Validator` adapter to learn.
 */

import type { ZodType } from "zod";

import { WebError } from "./errors";
import type { LestoRequest } from "./types";

/**
 * Validate `request.body` against `schema`, returning the parsed value.
 *
 * Throws `WebError("WEB_VALIDATION_FAILED")` — mapped to 422 by the error
 * boundary — when the body does not satisfy the schema. The Zod issues ride on
 * the error's `details.issues` for any caller that wants them.
 */
export function validateBody<T>(schema: ZodType<T>, request: LestoRequest): T {
  const parsed = schema.safeParse(request.body);

  if (!parsed.success) {
    throw new WebError("WEB_VALIDATION_FAILED", "Request body failed validation.", {
      issues: parsed.error.issues,
    });
  }

  return parsed.data;
}
