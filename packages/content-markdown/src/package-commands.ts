/**
 * Package-manager tabs as a rehype plugin.
 *
 * A fenced code block tagged `package-install` —
 *
 * ````md
 * ```package-install
 * npm install @lesto/queue
 * ```
 * ````
 *
 * — is rewritten into an accessible tablist with one panel per package manager
 * (npm / pnpm / yarn / bun). You author the npm command once; the pnpm, yarn,
 * and bun equivalents are derived by {@link convertNpmCommand}. The panels carry
 * `language-bash`, so a downstream syntax-highlight pass colors them like any
 * other shell block.
 *
 * The markup is server-rendered with every variant present and the npm panel
 * visible, so it works with no JavaScript (you can still read and copy the npm
 * command). The optional client enhancer (`@lesto/content-markdown/client`)
 * upgrades it: clicking a tab switches every block on the page and remembers the
 * choice. Only `package-install` blocks are touched, so the plugin is safe to
 * leave on by default.
 */

import { visit, SKIP } from "unist-util-visit";
import type { Root, Element, ElementContent, Properties, Text } from "hast";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** The package managers a `package-install` block expands to, in tab order. */
export const PACKAGE_MANAGERS: readonly PackageManager[] = ["npm", "pnpm", "yarn", "bun"];

/** The fenced-code language that opts a block into package-manager tabs. */
export const PACKAGE_INSTALL_LANG = "package-install";

const DEV_FLAGS = new Set(["-D", "--save-dev", "--dev"]);
const GLOBAL_FLAGS = new Set(["-g", "--global"]);

function tokenize(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function join(parts: string[]): string {
  return parts.filter((p) => p !== "").join(" ");
}

/** Translate npm install/add flags to the target manager (dev + global only;
 *  anything else passes through unchanged — honest about the supported set). */
function mapFlag(flag: string, target: PackageManager): string {
  if (DEV_FLAGS.has(flag)) return target === "bun" ? "-d" : "-D";
  if (GLOBAL_FLAGS.has(flag)) return "-g";
  return flag;
}

/**
 * Translate a single npm command line to another package manager.
 *
 * Handles the forms that show up in install docs — `install`/`i` (with `-D`,
 * `-g`, and package args), `run`, `npx` / `exec`, `create`, `ci`, and
 * `uninstall`/`remove`. A line that is not a recognized npm command (a comment,
 * a `cd`, an unknown subcommand) is returned unchanged, so a tab never shows a
 * command that is subtly wrong — at worst it shows the npm form verbatim.
 */
export function convertNpmCommand(command: string, target: PackageManager): string {
  if (target === "npm") return command;
  const trimmed = command.trim();
  if (trimmed === "") return command;

  // `npx <x>` → `pnpm dlx <x>` / `yarn dlx <x>` / `bunx <x>`
  const npx = /^npx\s+(.*)$/.exec(trimmed);
  if (npx) {
    const rest = npx[1]!;
    return target === "bun" ? `bunx ${rest}` : `${target} dlx ${rest}`;
  }

  const tokens = tokenize(trimmed);
  if (tokens[0] !== "npm") return command; // not an npm command → leave it be
  const sub = tokens[1];
  const args = tokens.slice(2);
  const packages = args.filter((a) => !a.startsWith("-"));
  const flags = args.filter((a) => a.startsWith("-"));
  const mappedFlags = flags.map((f) => mapFlag(f, target));
  const isGlobal = flags.some((f) => GLOBAL_FLAGS.has(f));

  switch (sub) {
    case "install":
    case "i":
    case "add": {
      if (packages.length === 0) {
        // No package operands: install the whole project.
        const lockFlags = mappedFlags.filter((f) => f !== "-g");
        return join([target, "install", ...lockFlags]);
      }
      // Yarn classic spells global installs `yarn global add <pkg>`.
      if (isGlobal && target === "yarn") {
        return join([
          "yarn",
          "global",
          "add",
          ...mappedFlags.filter((f) => f !== "-g"),
          ...packages,
        ]);
      }
      return join([target, "add", ...mappedFlags, ...packages]);
    }
    case "uninstall":
    case "remove":
    case "rm": {
      if (isGlobal && target === "yarn") {
        return join([
          "yarn",
          "global",
          "remove",
          ...mappedFlags.filter((f) => f !== "-g"),
          ...packages,
        ]);
      }
      return join([target, "remove", ...mappedFlags, ...packages]);
    }
    case "run": {
      const rest = args; // script name + any args/flags
      return target === "bun" ? join(["bun", "run", ...rest]) : join([target, ...rest]);
    }
    case "exec": {
      return target === "bun" ? join(["bunx", ...args]) : join([target, "dlx", ...args]);
    }
    case "create": {
      return join([target, "create", ...args]);
    }
    case "ci": {
      return join([target, "install", "--frozen-lockfile"]);
    }
    default:
      // Unknown subcommand: don't risk a wrong translation.
      return command;
  }
}

// ---------------------------------------------------------------------------
// hast helpers
// ---------------------------------------------------------------------------

function text(value: string): Text {
  return { type: "text", value };
}

function element(tagName: string, properties: Properties, children: ElementContent[]): Element {
  return { type: "element", tagName, properties, children };
}

/** Concatenate the text content of a `<code>` element. */
function codeText(code: Element): string {
  return code.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("")
    .replace(/\n$/, ""); // md4w appends a trailing newline inside <code>
}

function hasLang(code: Element, lang: string): boolean {
  const className = code.properties?.["className"];
  const classes = Array.isArray(className) ? className : [];
  return classes.includes(`language-${lang}`);
}

function buildTabs(command: string, id: string): Element {
  const lines = command.split("\n");

  const tabs: Element[] = [];
  const panels: Element[] = [];

  for (const pm of PACKAGE_MANAGERS) {
    const isDefault = pm === "npm";
    const tabId = `${id}-tab-${pm}`;
    const panelId = `${id}-panel-${pm}`;
    const translated = lines.map((line) => convertNpmCommand(line, pm)).join("\n");

    tabs.push(
      element(
        "button",
        {
          type: "button",
          className: ["lesto-pm-tab"],
          "data-pm": pm,
          role: "tab",
          id: tabId,
          "aria-selected": isDefault ? "true" : "false",
          "aria-controls": panelId,
          tabIndex: isDefault ? 0 : -1,
        },
        [text(pm)],
      ),
    );

    panels.push(
      element(
        "div",
        {
          className: ["lesto-pm-panel"],
          "data-pm": pm,
          role: "tabpanel",
          id: panelId,
          "aria-labelledby": tabId,
          ...(isDefault ? {} : { hidden: true }),
        },
        [
          element("pre", {}, [
            element("code", { className: ["language-bash"] }, [text(translated)]),
          ]),
        ],
      ),
    );
  }

  return element("div", { className: ["lesto-pm-tabs"], "data-pm-tabs": "" }, [
    element(
      "div",
      { className: ["lesto-pm-tablist"], role: "tablist", "aria-label": "Package manager" },
      tabs,
    ),
    element("div", { className: ["lesto-pm-panels"] }, panels),
  ]);
}

/**
 * Rehype plugin: expand `package-install` code blocks into package-manager tabs.
 */
export function rehypePackageCommands() {
  return (tree: Root): void => {
    let counter = 0;
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "pre") return undefined;

      const code = node.children.find(
        (child): child is Element => child.type === "element" && child.tagName === "code",
      );
      if (!code || !hasLang(code, PACKAGE_INSTALL_LANG)) return undefined;

      const command = codeText(code);
      if (command.trim() === "") return undefined;

      const id = `lesto-pm-${counter++}`;
      const tabs = buildTabs(command, id);

      // Reshape the <pre> node into the tab container in place.
      node.tagName = tabs.tagName;
      node.properties = tabs.properties;
      node.children = tabs.children;

      return SKIP;
    });
  };
}
