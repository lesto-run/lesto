import { defineConfig } from "vitest/config";

// The estate demo runs its tests in demo mode (KEEL_DEMO=1) via the setup file,
// so the committed fallback secrets and the passwordless `?as=` sign-in are
// reachable. The fail-closed production posture is asserted by tests that unset
// the flag locally.
export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
  },
});
