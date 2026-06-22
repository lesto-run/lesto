import { describe, it, expect } from "vitest";
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";
import { createRenderer } from "../renderer";
import {
  convertNpmCommand,
  rehypePackageCommands,
  PACKAGE_MANAGERS,
  type PackageManager,
} from "../package-commands";
import { packageCommandStyles } from "../package-commands-styles";

async function transform(html: string): Promise<string> {
  const file = await unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypePackageCommands)
    .use(rehypeStringify)
    .process(html);
  return String(file);
}

describe("convertNpmCommand", () => {
  // [npm input, { pnpm, yarn, bun }]
  const cases: Array<[string, Record<Exclude<PackageManager, "npm">, string>]> = [
    ["npm install", { pnpm: "pnpm install", yarn: "yarn install", bun: "bun install" }],
    [
      "npm install @lesto/queue",
      { pnpm: "pnpm add @lesto/queue", yarn: "yarn add @lesto/queue", bun: "bun add @lesto/queue" },
    ],
    ["npm i react", { pnpm: "pnpm add react", yarn: "yarn add react", bun: "bun add react" }],
    [
      "npm install -D vitest",
      { pnpm: "pnpm add -D vitest", yarn: "yarn add -D vitest", bun: "bun add -d vitest" },
    ],
    [
      "npm install -g lesto",
      { pnpm: "pnpm add -g lesto", yarn: "yarn global add lesto", bun: "bun add -g lesto" },
    ],
    ["npm run build", { pnpm: "pnpm build", yarn: "yarn build", bun: "bun run build" }],
    [
      "npx lesto dev",
      { pnpm: "pnpm dlx lesto dev", yarn: "yarn dlx lesto dev", bun: "bunx lesto dev" },
    ],
    [
      "npm create lesto@latest app",
      {
        pnpm: "pnpm create lesto@latest app",
        yarn: "yarn create lesto@latest app",
        bun: "bun create lesto@latest app",
      },
    ],
    [
      "npm uninstall left-pad",
      { pnpm: "pnpm remove left-pad", yarn: "yarn remove left-pad", bun: "bun remove left-pad" },
    ],
    [
      "npm ci",
      {
        pnpm: "pnpm install --frozen-lockfile",
        yarn: "yarn install --frozen-lockfile",
        bun: "bun install --frozen-lockfile",
      },
    ],
    ["npm exec foo", { pnpm: "pnpm dlx foo", yarn: "yarn dlx foo", bun: "bunx foo" }],
  ];

  for (const [input, expected] of cases) {
    it(`translates "${input}"`, () => {
      expect(convertNpmCommand(input, "pnpm")).toBe(expected.pnpm);
      expect(convertNpmCommand(input, "yarn")).toBe(expected.yarn);
      expect(convertNpmCommand(input, "bun")).toBe(expected.bun);
    });
  }

  it("returns the command unchanged for the npm target", () => {
    expect(convertNpmCommand("npm install foo", "npm")).toBe("npm install foo");
  });

  it("passes through non-npm lines verbatim (never guesses)", () => {
    for (const pm of ["pnpm", "yarn", "bun"] as const) {
      expect(convertNpmCommand("cd my-app", pm)).toBe("cd my-app");
      expect(convertNpmCommand("# a comment", pm)).toBe("# a comment");
      expect(convertNpmCommand("", pm)).toBe("");
    }
  });

  it("passes through unknown npm subcommands rather than mistranslating", () => {
    expect(convertNpmCommand("npm publish --access public", "pnpm")).toBe(
      "npm publish --access public",
    );
  });

  it("removes a global yarn flag when reordering to `yarn global`", () => {
    expect(convertNpmCommand("npm uninstall -g lesto", "yarn")).toBe("yarn global remove lesto");
  });
});

describe("rehypePackageCommands (plugin)", () => {
  it("expands a package-install block into a tablist with four panels", async () => {
    const html = await transform(
      '<pre><code class="language-package-install">npm install @lesto/queue</code></pre>',
    );

    expect(html).toContain('class="lesto-pm-tabs"');
    expect(html).toContain('role="tablist"');
    for (const pm of PACKAGE_MANAGERS) {
      expect(html).toContain(`data-pm="${pm}"`);
    }
    // npm tab selected and visible; others hidden.
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("hidden");
    // Translations present in their panels.
    expect(html).toContain("pnpm add @lesto/queue");
    expect(html).toContain("yarn add @lesto/queue");
    expect(html).toContain("bun add @lesto/queue");
  });

  it("translates every line of a multi-line block", async () => {
    const html = await transform(
      '<pre><code class="language-package-install">npm install\nnpm run build</code></pre>',
    );
    expect(html).toContain("pnpm install");
    expect(html).toContain("pnpm build");
  });

  it("leaves ordinary code blocks untouched", async () => {
    const html = await transform('<pre><code class="language-bash">ls -la</code></pre>');
    expect(html).not.toContain("lesto-pm-tabs");
    expect(html).toContain("ls -la");
  });

  it("ignores an empty package-install block", async () => {
    const html = await transform('<pre><code class="language-package-install">  </code></pre>');
    expect(html).not.toContain("lesto-pm-tabs");
  });
});

describe("package tabs via createRenderer (md4w hybrid, default-on)", () => {
  it("renders tabs end-to-end from a package-install fence", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("```package-install\nnpm install @lesto/db\n```");

    expect(result.html).toContain("lesto-pm-tabs");
    expect(result.html).toContain("pnpm add @lesto/db");
    expect(result.html).toContain("bun add @lesto/db");
  });

  it("can be disabled with packageCommands: false", async () => {
    const renderer = createRenderer({ packageCommands: false });
    const result = await renderer.render("```package-install\nnpm install x\n```");

    expect(result.html).not.toContain("lesto-pm-tabs");
  });

  it("escapes command text — markup in a command cannot inject", async () => {
    const renderer = createRenderer();
    const result = await renderer.render(
      "```package-install\nnpm install <script>alert(1)</script>\n```",
    );

    expect(result.html).toContain("lesto-pm-tabs");
    expect(result.html).not.toContain("<script>alert");
  });
});

describe("packageCommandStyles", () => {
  it("is a stylesheet keyed off the public class names", () => {
    expect(packageCommandStyles).toContain(".lesto-pm-tabs");
    expect(packageCommandStyles).toContain(".lesto-pm-tab");
    expect(packageCommandStyles).toContain('[aria-selected="true"]');
  });
});
