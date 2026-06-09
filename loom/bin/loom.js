#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

// The Loom CLI. It boots a Vite dev server in middleware mode purely as a
// module loader, so every command can `ssrLoadModule` the engine's JSX/ESM
// source without a separate build step — the same way Vite-based frameworks
// (TanStack Start, etc.) run their tooling.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PAGES_DIR = path.join(ROOT, 'pages');

const C = { reset: '\x1b[0m', dim: '\x1b[90m', green: '\x1b[32m', cyan: '\x1b[36m', mag: '\x1b[35m', red: '\x1b[31m', yellow: '\x1b[33m' };
const c = (k, s) => `${C[k]}${s}${C.reset}`;

let _vite;
async function vite() {
  // noDiscovery: we only ssrLoadModule source — skip the client dep pre-scan
  // (which otherwise races with our quick shutdown and logs spurious errors).
  if (!_vite) _vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } });
  return _vite;
}
async function load(p) {
  return (await vite()).ssrLoadModule(p);
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page';
}

const commands = {
  // loom generate "<prompt>" [-o pages/x.json] [--mock]
  async generate(args) {
    const flags = parseFlags(args);
    const prompt = flags._.join(' ');
    if (!prompt) return fail('Usage: loom generate "<prompt>" [-o pages/name.json] [--mock]');

    const { generate } = await load('/src/generate.js');
    const generator = flags.mock ? 'mock' : flags.anthropic ? 'anthropic' : 'auto';
    process.stdout.write(c('dim', `  generating (${generator})…\n`));

    const result = await generate(prompt, { generator });
    const out = flags.o || flags.out || path.join('pages', `${slug(prompt)}.json`);
    const abs = path.isAbsolute(out) ? out : path.join(ROOT, out);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(result.tree, null, 2) + '\n');

    const rel = path.relative(ROOT, abs);
    console.log(`  ${c('green', 'created')}  ${rel}  ${c('dim', `(${nodeCount(result.tree)} nodes, via ${result.generator})`)}`);
    if (!result.valid) {
      console.log(c('yellow', `  repaired ${result.errors.length} invalid node(s) before saving:`));
      for (const e of result.errors.slice(0, 5)) console.log(c('dim', `    - ${e.type} ${e.component || ''} ${e.detail || ''}`));
    }
    console.log(c('dim', `  preview: loom dev → http://localhost:5173/p/${path.basename(rel, '.json')}`));
  },

  // loom render <name> [-o file.html]  — static SSR, no client JS
  async render(args) {
    const flags = parseFlags(args);
    const name = flags._[0];
    if (!name) return fail('Usage: loom render <page-name> [-o out.html]');
    const tree = readPage(name);
    if (!tree) return fail(`No page "${name}" in pages/`);

    const { render } = await load('/src/entry-server.jsx');
    const { html, errors } = render(tree);
    const doc = standaloneDoc(name, html);

    if (flags.o || flags.out) {
      const abs = path.resolve(process.cwd(), flags.o || flags.out);
      fs.writeFileSync(abs, doc);
      console.log(`  ${c('green', 'rendered')}  ${abs}  ${c('dim', `(${html.length} bytes${errors.length ? `, ${errors.length} warnings` : ''})`)}`);
    } else {
      process.stdout.write(doc + '\n');
    }
  },

  // loom build — statically render every page to dist/*.html
  async build() {
    const pages = listPages();
    if (!pages.length) return fail('No pages to build. Generate one first.');
    const { render } = await load('/src/entry-server.jsx');
    const dist = path.join(ROOT, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    console.log();
    for (const name of pages) {
      const { html } = render(readPage(name));
      const file = path.join(dist, `${name}.html`);
      fs.writeFileSync(file, standaloneDoc(name, html));
      console.log(`  ${c('green', 'built')}  dist/${name}.html  ${c('dim', `(${html.length} bytes)`)}`);
    }
    console.log(c('dim', `\n  ${pages.length} page(s) → static HTML, zero JS, instantly servable.\n`));
  },

  // loom manifest [--json | --schema]
  async manifest(args) {
    const flags = parseFlags(args);
    // Load the barrel so the component library is registered before we read it.
    const m = await load('/src/index.js');
    if (flags.schema) return console.log(JSON.stringify(m.treeJsonSchema(), null, 2));
    if (flags.json) return console.log(JSON.stringify(m.componentCatalog(), null, 2));
    console.log(m.manifestMarkdown());
  },

  // loom components — quick list of the registry
  async components() {
    const comps = (await load('/src/index.js')).allComponents();
    console.log();
    for (const comp of comps) {
      const props = Object.keys(comp.props).join(', ') || c('dim', 'none');
      console.log(`  ${c('cyan', comp.name.padEnd(13))} ${c('dim', comp.description)}`);
      console.log(`  ${' '.repeat(13)} ${c('dim', 'props: ')}${props}`);
    }
    console.log(c('dim', `\n  ${comps.length} components registered.\n`));
  },

  // loom dev — start the SSR dev server (separate process)
  async dev(args) {
    await closeVite();
    const flags = parseFlags(args);
    const env = { ...process.env };
    if (flags.port || flags.p) env.PORT = flags.port || flags.p;
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { stdio: 'inherit', env });
    child.on('exit', (code) => process.exit(code ?? 0));
    return new Promise(() => {}); // keep alive
  },

  help() {
    console.log(`
  ${c('mag', '🧵 Loom')} — an AI-native React rendering engine.

  ${c('cyan', 'loom generate')} "<prompt>" [-o pages/x.json] [--mock]
                          Generate a UI tree artifact from a prompt
  ${c('cyan', 'loom dev')} [--port N]      Start the SSR dev server (HMR + hydration)
  ${c('cyan', 'loom render')} <name> [-o f.html]
                          Statically SSR a page to HTML (no client JS)
  ${c('cyan', 'loom build')}              Render every page to dist/*.html
  ${c('cyan', 'loom manifest')} [--json|--schema]
                          Print the component manifest the AI designs against
  ${c('cyan', 'loom components')}         List the registered component vocabulary

  ${c('dim', 'Without ANTHROPIC_API_KEY, generation uses the offline mock generator.')}
`);
  },
};

const ALIASES = { g: 'generate', '-h': 'help', '--help': 'help' };

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) { out[key] = next; i++; } else out[key] = true;
    } else if (a.startsWith('-')) {
      const key = a.slice(1);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function listPages() {
  if (!fs.existsSync(PAGES_DIR)) return [];
  return fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}
function readPage(name) {
  const file = path.join(PAGES_DIR, `${name.replace(/\.json$/, '')}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
function nodeCount(tree) {
  if (!tree || typeof tree !== 'object') return 0;
  return 1 + (Array.isArray(tree.children) ? tree.children.reduce((n, c) => n + nodeCount(c), 0) : 0);
}
function standaloneDoc(title, html) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="margin:0"><div id="app">${html}</div></body></html>\n`;
}
function fail(msg) {
  console.error(`\n  ${c('red', 'Error:')} ${msg}\n`);
  process.exitCode = 1;
}
async function closeVite() {
  if (_vite) { await _vite.close(); _vite = null; }
}

async function main() {
  const [, , raw, ...args] = process.argv;
  const cmd = ALIASES[raw] || raw || 'help';
  const fn = commands[cmd];
  if (!fn) {
    fail(`Unknown command: ${raw}`);
    return commands.help();
  }
  try {
    await fn(args);
  } catch (err) {
    fail(err.message);
    if (process.env.LOOM_DEBUG) console.error(err.stack);
  } finally {
    if (cmd !== 'dev') await closeVite();
  }
}

main();
