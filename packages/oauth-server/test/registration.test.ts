import { describe, expect, it } from "vitest";

import { notImplemented, OAuthServerError } from "../src/errors";
import { createClientResolver, looksLikeCimdClientId } from "../src/registration";
import type { RegistrationConfig } from "../src/types";

const config: RegistrationConfig = { dynamicRegistration: false };

// SKELETON (ADR 0040). These tests assert exactly one thing the skeleton DOES promise:
// every entry point refuses with `OAUTH_NOT_IMPLEMENTED` rather than silently half-working.
// That keeps a non-functional package honest — it cannot be mistaken for shippable DCR.
describe("@lesto/oauth-server skeleton", () => {
  it("createClientResolver returns a seam that refuses until built", () => {
    const resolve = createClientResolver(config);

    // The stub throws synchronously on invocation — honest for a non-functional seam.
    expect(() => resolve("https://claude.ai/.well-known/oauth-client")).toThrow(OAuthServerError);
  });

  it("notImplemented throws an OAuthServerError carrying the code", () => {
    expect(() => notImplemented("x")).toThrow(OAuthServerError);
    expect(() => notImplemented("x")).toThrow(/non-functional skeleton/);
  });

  it("looksLikeCimdClientId is a stub (dispatch shape declared, body unbuilt)", () => {
    expect(() => looksLikeCimdClientId("https://example.com")).toThrow(OAuthServerError);
  });
});

// The contract the REAL build (ADR 0029 Phase 3) must satisfy. Skipped — there is no
// behavior to test yet. This list is the registration spec, executable-shaped, so the
// build has a target and the ADR 0039 D5 security review has a checklist.
describe.skip("@lesto/oauth-server registration (PENDING — ADR 0029 Phase 3)", () => {
  it.todo("CIMD: rejects a non-https client_id URL before any fetch (SSRF guard)");
  it.todo("CIMD: rejects a client_id URL with a fragment");
  it.todo("CIMD: rejects a client_id host resolving to loopback / RFC 1918 / link-local");
  it.todo("CIMD: re-runs the SSRF guard on every redirect hop");
  it.todo("CIMD: requires the document client_id to byte-equal the fetched URL");
  it.todo("CIMD: rejects a metadata document requesting the implicit grant");
  it.todo("CIMD: positive- and negative-caches by URL (no fetch-amplification)");

  it.todo("DCR: POST /register returns access_denied when dynamicRegistration is off");
  it.todo("DCR: rate-limits registration per-IP and globally");
  it.todo("DCR: validates redirect_uris are absolute https, exact, no wildcard");
  it.todo("DCR: never dereferences a redirect_uri at registration");
  it.todo("DCR: requires a verified software statement when a trust anchor is configured");
  it.todo("DCR: mints an opaque client_id and persists an immutable record");

  it.todo("resolveClient: an https URL dispatches to CIMD; an opaque id to the store");
  it.todo("aud/resource: registering a client never registers a resource (confused-deputy)");
  it.todo("authorize: exact redirect_uri match — no prefix/substring/wildcard");
});
