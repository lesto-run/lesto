/**
 * The interim PostHog driver — the only file that knows PostHog exists.
 *
 * It loads posthog-js from the configured host on `init()` (queuing any calls
 * made before the SDK finishes loading, then replaying them), and maps the
 * {@link AnalyticsDriver} methods onto posthog's `capture`/`identify`. When
 * `@lesto/analytics` ships, this whole file is replaced by the battery's driver —
 * nothing else changes.
 *
 * OFF by default: with no `key` configured it disables itself, so no SDK loads
 * and no cookie is set until analytics is intentionally turned on.
 */

import { ANALYTICS_CONFIG } from "./config";
import type { AnalyticsDriver, EventProps } from "./client";

/** The slice of the posthog-js global this driver uses. */
interface PosthogGlobal {
  init(key: string, options: Record<string, unknown>): void;
  capture(event: string, props?: EventProps): void;
  identify(distinctId: string, traits?: EventProps): void;
}

function posthog(): PosthogGlobal | undefined {
  return (globalThis as { posthog?: PosthogGlobal }).posthog;
}

/** Build the PostHog-backed driver. `config` is injectable for tests. */
export function posthogDriver(config = ANALYTICS_CONFIG): AnalyticsDriver {
  let ready = false;
  let disabled = false;
  const pending: Array<(ph: PosthogGlobal) => void> = [];

  // Run now if the SDK is ready, else queue until `load` fires.
  function run(action: (ph: PosthogGlobal) => void): void {
    if (disabled) return;
    const ph = posthog();
    if (ready && ph !== undefined) {
      action(ph);
    } else {
      pending.push(action);
    }
  }

  return {
    init() {
      // OFF until a key is configured, and only ever in a browser.
      if (config.key === "" || typeof document === "undefined") {
        disabled = true;
        return;
      }

      const script = document.createElement("script");
      script.src = `${config.host}/static/array.full.js`;
      script.async = true;
      script.addEventListener("load", () => {
        const ph = posthog();
        if (ph === undefined) {
          disabled = true;
          return;
        }
        ph.init(config.key, {
          api_host: config.host,
          capture_pageview: false, // we send page views ourselves, via page()
          respect_dnt: true,
          // The seam's contract is explicit events only (page/track + the
          // `data-analytics` convention). Disable PostHog's default DOM-wide
          // autocapture, session recording, and perf capture so enabling
          // analytics never silently records more than we declare.
          autocapture: false,
          disable_session_recording: true,
          capture_performance: false,
        });
        ready = true;
        for (const action of pending.splice(0)) {
          const live = posthog();
          if (live !== undefined) action(live);
        }
      });
      document.head.appendChild(script);
    },

    page(props) {
      run((ph) => {
        ph.capture("$pageview", props);
      });
    },

    track(event, props) {
      run((ph) => {
        ph.capture(event, props);
      });
    },

    identify(distinctId, traits) {
      run((ph) => {
        ph.identify(distinctId, traits);
      });
    },
  };
}
