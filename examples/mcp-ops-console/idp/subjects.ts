/**
 * The subject schema the OpenAuth issuer mints tokens for.
 *
 * OpenAuth's access token is subject-based: the JWT carries `sub`, `aud` (the client id),
 * `iss`, `exp`, and a `properties` object — exactly the subject properties defined here.
 * There is no OAuth `scope` claim, so the GRANT's scopes ride in `properties.scopes`, and
 * the principal's ROLE rides in `properties.role`; the Resource Server's `VerifyAccessToken`
 * seam reads the scopes back out (see ../mcp/verify.ts) and `rolesOf` maps the subject id to
 * the role for the per-tool policy floor (../mcp/governance.ts).
 */

import { createSubjects } from "@openauthjs/openauth/subject";
import { array, object, string } from "valibot";

export const subjects = createSubjects({
  user: object({
    /** Who the principal is — becomes the RS actor / audit attribution. */
    userID: string(),

    /** The MCP scopes this grant carries — the ceiling the RS enforces today (`mcp:read`/`mcp:write`). */
    scopes: array(string()),

    /**
     * The principal's ops role (`sre` / `oncall` / `viewer`). It rides in the token so the RS
     * could attribute it directly, but the RS resolves it from the SUBJECT via `rolesOf` (its
     * source of truth is the identity service, not the token) — the property is here so the demo
     * issuer and the RS agree without a side channel. The OCP-7 per-tool policy floor reads roles.
     */
    role: string(),
  }),
});
