/**
 * A headless island that wires the "Copy as Markdown" page action — fetch the
 * page's `.md` twin and copy it to the clipboard.
 *
 * NOTE on dogfooding: the per-code-block "Copy" button is NOT done here — it is
 * emitted by `@lesto/content-markdown`'s Shiki pipeline (the `transformerCopyButton`,
 * a self-contained inline-onclick button), and the docs only style it. This island
 * handles the one thing the framework doesn't: copying the whole page as Markdown,
 * which is Lesto's agent-native page action, not a code-block concern.
 *
 * Like the analytics island it renders nothing visible and runs once on mount.
 */

import { defineIsland } from "@lesto/ui";
import { useEffect } from "react";
import type { ReactElement } from "react";

const COPIED_MS = 1500;

/** Flash a button's label to confirm a copy, then restore it. */
function flash(button: HTMLButtonElement, ok: boolean): void {
  const original = button.dataset["label"] ?? button.textContent ?? "Copy as Markdown";
  button.dataset["label"] = original;
  button.textContent = ok ? "Copied" : "Failed";
  button.classList.add("copied");
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove("copied");
  }, COPIED_MS);
}

/** Wire each "Copy as Markdown" action: fetch the page's .md twin, copy it. */
function wireCopyMarkdown(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy-md]")) {
    if (button.dataset["wired"] === "1") continue;
    button.dataset["wired"] = "1";
    const url = button.dataset["copyMd"];
    if (url === undefined) continue;

    button.addEventListener("click", () => {
      void (async () => {
        try {
          const response = await fetch(url);
          const markdown = await response.text();
          await navigator.clipboard.writeText(markdown);
          flash(button, true);
        } catch {
          flash(button, false);
        }
      })();
    });
  }
}

function CopyMarkdownBoot(): ReactElement {
  useEffect(() => {
    wireCopyMarkdown();
  }, []);

  return <span data-copy-root hidden />;
}

export default defineIsland({
  name: "CopyCode",
  component: CopyMarkdownBoot,
  fallback: () => <span data-copy-root hidden />,
});
