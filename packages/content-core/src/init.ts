import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveConfigFile } from "./config";

export interface InitOptions {
  /** Accept defaults without prompting (for CI/non-interactive environments) */
  yes?: boolean;
}

type Framework = "next" | "tanstack-start" | "tanstack-router" | "vite" | "remix" | "unknown";

interface FrameworkDetection {
  framework: Framework;
  viteConfig?: string;
  nextConfig?: string;
  packageJson?: PackageJson;
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function createReadlineInterface() {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function prompt(
  rl: ReturnType<typeof createReadlineInterface>,
  question: string,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function detectFramework(cwd: string): Promise<FrameworkDetection> {
  const result: FrameworkDetection = { framework: "unknown" };

  // Check for package.json
  const pkgPath = path.join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const content = await readFile(pkgPath, "utf-8");
      result.packageJson = JSON.parse(content) as PackageJson;
    } catch {
      // Ignore parse errors
    }
  }

  const deps = {
    ...result.packageJson?.dependencies,
    ...result.packageJson?.devDependencies,
  };

  // Check for framework-specific config files
  const viteConfigs = ["vite.config.ts", "vite.config.js", "vite.config.mjs"];
  for (const config of viteConfigs) {
    const configPath = path.join(cwd, config);
    if (existsSync(configPath)) {
      result.viteConfig = config;
      break;
    }
  }

  const nextConfigs = ["next.config.ts", "next.config.js", "next.config.mjs"];
  for (const config of nextConfigs) {
    const configPath = path.join(cwd, config);
    if (existsSync(configPath)) {
      result.nextConfig = config;
      break;
    }
  }

  // Detect framework based on dependencies
  if ("next" in deps) {
    result.framework = "next";
  } else if ("@tanstack/start" in deps || "@tanstack/react-start" in deps) {
    result.framework = "tanstack-start";
  } else if ("@tanstack/react-router" in deps && result.viteConfig) {
    result.framework = "tanstack-router";
  } else if ("@remix-run/react" in deps || "@remix-run/node" in deps) {
    result.framework = "remix";
  } else if (result.viteConfig) {
    result.framework = "vite";
  }

  return result;
}

function getFrameworkDisplayName(framework: Framework): string {
  const names: Record<Framework, string> = {
    next: "Next.js",
    "tanstack-start": "TanStack Start",
    "tanstack-router": "TanStack Router + Vite",
    vite: "Vite",
    remix: "Remix",
    unknown: "Unknown",
  };
  return names[framework];
}

async function updatePackageJson(cwd: string, packageJson: PackageJson | undefined): Promise<void> {
  const pkgPath = path.join(cwd, "package.json");
  const pkg: PackageJson = packageJson ?? {};

  // Add @volo/content-core to dependencies if not present
  pkg.dependencies = pkg.dependencies ?? {};
  if (!pkg.dependencies["@volo/content-core"]) {
    pkg.dependencies["@volo/content-core"] = "^0.0.1";
    console.log("  Added @volo/content-core to dependencies");
  }

  // Add generate script if not present
  pkg.scripts = pkg.scripts ?? {};
  if (!pkg.scripts.generate && !pkg.scripts["docks:generate"]) {
    pkg.scripts["generate"] = "docks generate";
    console.log("  Added 'generate' script");
  }

  // Add dev:docks script if not present
  if (!pkg.scripts["dev:docks"]) {
    pkg.scripts["dev:docks"] = "docks dev";
    console.log("  Added 'dev:docks' script");
  }

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

async function updateViteConfig(cwd: string, viteConfigFile: string): Promise<void> {
  const configPath = path.join(cwd, viteConfigFile);
  const content = await readFile(configPath, "utf-8");

  // Check if docks plugin is already imported
  if (content.includes("@volo/content-vite-plugin") || content.includes("docks(")) {
    console.log("  Vite config already includes Docks plugin");
    return;
  }

  // Add import and plugin
  const updatedContent = content
    // Add import at the top
    .replace(
      /(import .* from ['"]vite['"];?)/,
      '$1\nimport docks from "@volo/content-vite-plugin";',
    )
    // Add plugin to plugins array
    .replace(/plugins:\s*\[/, "plugins: [docks(), ");

  if (updatedContent !== content) {
    await writeFile(configPath, updatedContent, "utf-8");
    console.log(`  Updated ${viteConfigFile} with Docks plugin`);
  } else {
    console.log(`  Could not auto-update ${viteConfigFile}. Please add the Docks plugin manually:`);
    console.log('    import docks from "@volo/content-vite-plugin";');
    console.log("    // Add docks() to your plugins array");
  }
}

async function updateNextConfig(cwd: string, nextConfigFile: string): Promise<void> {
  const configPath = path.join(cwd, nextConfigFile);
  const content = await readFile(configPath, "utf-8");

  // Check if docks is already configured
  if (content.includes("@volo/content-next") || content.includes("withDocks")) {
    console.log("  Next.js config already includes Docks");
    return;
  }

  console.log(
    `  Could not auto-update ${nextConfigFile}. Please add the Docks configuration manually:`,
  );
  console.log('    import { withDocks } from "@volo/content-next";');
  console.log("    export default withDocks(nextConfig);");
}

export async function runInit(cwd: string, options: InitOptions = {}): Promise<void> {
  console.log("Initializing Docks project...\n");

  // Check if config already exists
  const existingConfig = await resolveConfigFile(cwd);
  if (existingConfig) {
    console.error(`Error: Config file already exists at ${existingConfig.path}`);
    console.error("Remove it first or run this command in a different directory.");
    process.exit(1);
  }

  // Detect framework
  const detection = await detectFramework(cwd);
  if (detection.framework !== "unknown") {
    console.log(`Detected framework: ${getFrameworkDisplayName(detection.framework)}`);
  }

  let collectionName: string;
  let contentDir: string;

  if (options.yes) {
    // Non-interactive mode: use defaults
    collectionName = "posts";
    contentDir = "content/posts";
    console.log(`Using defaults: collection="${collectionName}", directory="${contentDir}"`);
  } else {
    const rl = createReadlineInterface();
    try {
      // Prompt for collection name
      const collectionNameInput = await prompt(rl, "Collection name (default: posts): ");
      collectionName = collectionNameInput || "posts";

      // Prompt for content directory
      const defaultDir = `content/${collectionName}`;
      const contentDirInput = await prompt(rl, `Content directory (default: ${defaultDir}): `);
      contentDir = contentDirInput || defaultDir;
      rl.close();
    } catch (error) {
      rl.close();
      throw error;
    }
  }

  // Create content directory
  const contentDirPath = path.join(cwd, contentDir);
  await mkdir(contentDirPath, { recursive: true });
  console.log(`\nCreated directory: ${contentDir}`);

  // Generate docks.config.ts
  const configContent = `import { defineConfig, defineCollection } from "@volo/content-core";
import { z } from "zod";

const ${collectionName}Schema = z.object({
  title: z.string(),
  description: z.string(),
  publishedAt: z.coerce.date(),
  draft: z.boolean().default(false),
});

const ${collectionName} = defineCollection({
  name: "${collectionName}",
  directory: "${contentDir}",
  include: "**/*.md",
  schema: ${collectionName}Schema,
});

export default defineConfig({
  collections: [${collectionName}],
});
`;

  const configPath = path.join(cwd, "docks.config.ts");
  await writeFile(configPath, configContent, "utf-8");
  console.log(`Created config: docks.config.ts`);

  // Create example hello-world.md post
  const exampleContent = `---
title: "Hello World"
description: "Welcome to Docks!"
publishedAt: "${new Date().toISOString()}"
draft: false
---

# Hello World

Welcome to your new Docks project! This is your first content entry.

Edit this file to get started, or create new entries with:

\`\`\`bash
docks new ${collectionName} "Your Title Here"
\`\`\`
`;

  const examplePath = path.join(contentDirPath, "hello-world.md");
  await writeFile(examplePath, exampleContent, "utf-8");
  console.log(`Created example post: ${contentDir}/hello-world.md`);

  // Update package.json
  console.log("\nUpdating package.json:");
  await updatePackageJson(cwd, detection.packageJson);

  // Update framework config
  if (detection.viteConfig) {
    console.log("\nUpdating Vite config:");
    await updateViteConfig(cwd, detection.viteConfig);
  }

  if (detection.nextConfig) {
    console.log("\nUpdating Next.js config:");
    await updateNextConfig(cwd, detection.nextConfig);
  }

  console.log("\nDocks project initialized successfully!");
  console.log("\nNext steps:");
  console.log("  1. Install dependencies: npm install (or your package manager)");
  console.log(`  2. Edit ${contentDir}/hello-world.md`);
  console.log('  3. Run "docks generate" to build your content');
  console.log('  4. Run "docks dev" to watch for changes');
}
