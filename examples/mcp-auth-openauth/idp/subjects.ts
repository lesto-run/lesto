/**
 * The subject schema the OpenAuth issuer mints tokens for.
 *
 * OpenAuth's access token is subject-based: the JWT carries `sub`, `aud` (the client id),
 * `iss`, `exp`, and a `properties` object — exactly the subject properties defined here.
 * There is no OAuth `scope` claim, so the GRANT's scopes ride in `properties.scopes`; the
 * Resource Server's `VerifyAccessToken` seam reads them back out (see ../mcp/verify.ts).
 */

import { createSubjects } from "@openauthjs/openauth/subject";
import { array, object, string } from "valibot";

export const subjects = createSubjects({
  user: object({
    /** Who the principal is — becomes the RS actor / audit attribution. */
    userID: string(),

    /** The MCP scopes this grant carries — the ceiling the RS enforces (`mcp:read`/`mcp:write`). */
    scopes: array(string()),
  }),
});
