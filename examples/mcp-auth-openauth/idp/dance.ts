/**
 * The real OAuth dance against the OpenAuth issuer, run programmatically (no browser).
 *
 * It's the genuine PKCE flow — `client.authorize` → `/authorize` → the provider → `code` →
 * `client.exchange` → token — only the interactive login is short-circuited by the demo
 * providers (../idp/issuer.ts). A real client/agent runs exactly this; here a small
 * cookie-aware redirect follower stands in for the browser.
 */

import { createClient } from "@openauthjs/openauth/client";

/** The OAuth client id used for the dance; OpenAuth stamps it as the token `aud`. */
export const CLIENT_ID = "lesto-mcp-demo";

/** A loopback redirect the demo never actually serves — we intercept the `code` off it. */
const REDIRECT = "http://localhost:9999/callback";

/** Follow redirects manually with a cookie jar until the callback fires, returning the `code`. */
async function followToCode(startUrl: string, origin: string): Promise<string> {
  let url = startUrl;
  let cookies = "";

  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      headers: cookies ? { cookie: cookies } : {},
    });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookies = [cookies, setCookie.split(";")[0]].filter(Boolean).join("; ");

    const location = res.headers.get("location");
    if (location === null) throw new Error(`no redirect at hop ${hop} (status ${res.status})`);

    const next = new URL(location, origin);
    if (next.href.startsWith(REDIRECT)) {
      const code = next.searchParams.get("code");
      if (code === null) throw new Error(`callback without a code: ${next.href}`);

      return code;
    }
    url = next.href;
  }

  throw new Error("too many redirects without reaching the callback");
}

/**
 * Run the dance and return an access token for `provider` (`operator` | `viewer`), minted for
 * `clientID` (default {@link CLIENT_ID}; pass another to forge a wrong-audience token).
 */
export async function getAccessToken(
  issuerUrl: string,
  provider: "operator" | "viewer",
  clientID: string = CLIENT_ID,
): Promise<string> {
  const client = createClient({ clientID, issuer: issuerUrl });
  const { challenge, url } = await client.authorize(REDIRECT, "code", { pkce: true, provider });
  const code = await followToCode(url, issuerUrl);
  const exchanged = await client.exchange(code, REDIRECT, challenge.verifier);
  if (exchanged.err) throw new Error(`exchange failed: ${String(exchanged.err)}`);

  return exchanged.tokens.access;
}
