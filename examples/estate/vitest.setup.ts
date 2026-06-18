/**
 * Test setup for the estate demo.
 *
 * The estate example IS the public demo, so its test suites run in demo mode:
 * `VOLO_DEMO=1` enables the committed fallback secrets and the passwordless
 * `?as=` sign-in the demo relies on. A real deploy never sets this flag — that
 * is exactly the fail-closed posture the security tests assert against (an unset
 * secret outside demo mode refuses to serve). Tests that need the production
 * posture override the env locally.
 */

process.env["VOLO_DEMO"] = "1";
