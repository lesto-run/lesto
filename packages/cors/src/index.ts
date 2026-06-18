/**
 * @volo/cors — CORS header computation.
 *
 *   const headers = corsHeaders(req.headers.origin, {
 *     origin: ["https://app.example.com"],
 *     credentials: true,
 *     maxAge: 600,
 *   });
 *   for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
 */

export { corsHeaders, CorsError } from "./cors";
export type { CorsErrorCode, CorsOptions } from "./cors";

export { cors } from "./middleware";
