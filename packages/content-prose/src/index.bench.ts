/**
 * Lumen Benchmark Suite
 *
 * Benchmarks lumen's performance using the CLI, which captures the full
 * end-to-end cost including:
 * - Process startup and initialization
 * - CLI argument parsing (Commander)
 * - File I/O (reading markdown files)
 * - Linting (all 10 rules)
 * - Output formatting
 * - Process exit
 *
 * This approach avoids hardcoding internal API calls, making benchmarks
 * resilient to refactoring and representative of real-world usage.
 *
 * Comparison with textlint uses their CLI as well for fair comparison.
 *
 * NOTE: Different rule sets are being compared:
 * - lumen: 10 rules (fillers, weasel, hedge, condescending, repeated,
 *   simplify, profanity, passive, adverbs, cliches)
 * - textlint write-good: ~8 rules (passive, illusion, so, thereIs,
 *   weasel, adverb, tooWordy, cliches)
 */
import { bench, describe, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Paths to CLI binaries
const lumenBin = join(import.meta.dirname, '../bin/lumen.js');
const textlintBin = join(import.meta.dirname, '../node_modules/.bin/textlint');

// Temp directory for benchmark fixtures
const tmpDir = join(import.meta.dirname, '../.bench-tmp');

// Sample content with various issues to detect
const shortContent = `---
title: Hello World
---

# Hello World

This is basically a very simple test. I think it's obviously easy to use.
`;

const mediumContent = `---
title: Getting Started Guide
---

# Getting Started

This guide will help you get started quickly. It's really simple to utilize this framework.

## Installation

Many developers basically just run the install command. The package was designed to be very easy to use.

## Configuration

I think the configuration is obviously straightforward. You simply add the config file and it clearly works.

${Array(10)
  .fill(
    `
## Section

Various features were implemented to help you. Perhaps you want to leverage the API, or maybe utilize the CLI. It's really just a matter of preference.

The system was built to be extremely fast and basically handles everything automatically. Some developers think it's obviously the best choice.
`
  )
  .join('\n')}
`;

const longContent = `---
title: Complete Reference
---

# Complete Reference

${Array(50)
  .fill(
    `
## Chapter

This chapter covers various topics that were implemented recently. I think it's obviously important to understand these concepts.

### Overview

Many features basically leverage the core API. The system was designed to be very intuitive and really easy to use.

### Details

Perhaps you want to utilize the advanced features. It's simply a matter of reading the documentation clearly. Some edge cases were handled automatically.

### Examples

Various examples were created to help developers. I believe they're basically essential for understanding. The code was written to be extremely readable.

\`\`\`javascript
// This is really just a simple example
function process(data) {
  return data;
}
\`\`\`

> Obviously, this is just the beginning. Many more features are available.
`
  )
  .join('\n')}
`;

function setupFiles() {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'short.md'), shortContent);
  writeFileSync(join(tmpDir, 'medium.md'), mediumContent);
  writeFileSync(join(tmpDir, 'long.md'), longContent);
}

function cleanupFiles() {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

// CLI runner helpers
function runLumen(fileOrPattern: string) {
  return spawnSync('node', [lumenBin, fileOrPattern], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function runTextlint(fileOrPattern: string) {
  return spawnSync(textlintBin, ['--rule', 'write-good', fileOrPattern], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

// Setup fixtures before benchmarks run
beforeAll(() => {
  setupFiles();
});

// Cleanup after benchmarks complete
afterAll(() => {
  cleanupFiles();
});

/**
 * CLI Benchmarks
 *
 * These benchmarks spawn actual processes, measuring the full CLI experience.
 * This includes process startup overhead, which is representative of how
 * users actually invoke the tool.
 */
describe('CLI Benchmark: Short Content (~100 words)', () => {
  const file = join(tmpDir, 'short.md');

  bench('lumen', () => {
    runLumen(file);
  });

  bench('textlint (write-good)', () => {
    runTextlint(file);
  });
});

describe('CLI Benchmark: Medium Content (~500 words)', () => {
  const file = join(tmpDir, 'medium.md');

  bench('lumen', () => {
    runLumen(file);
  });

  bench('textlint (write-good)', () => {
    runTextlint(file);
  });
});

describe('CLI Benchmark: Long Content (~2500 words)', () => {
  const file = join(tmpDir, 'long.md');

  bench('lumen', () => {
    runLumen(file);
  });

  bench('textlint (write-good)', () => {
    runTextlint(file);
  });
});

describe('CLI Benchmark: Multiple Files (glob pattern)', () => {
  const pattern = join(tmpDir, '*.md');

  bench('lumen', () => {
    runLumen(pattern);
  });

  bench('textlint (write-good)', () => {
    runTextlint(pattern);
  });
});
