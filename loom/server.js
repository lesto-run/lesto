import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

// Loom's dev server. For each request it:
//   /            → an index listing every generated page artifact
//   /p/<name>    → loads pages/<name>.json, SSR-renders it via entry-server,
//                  and hydrates on the client (full HMR via Vite middleware).
//
// The key performance property: rendering a route reads a static JSON artifact
// and runs the renderer — there is NO model call in the request path. The AI ran
// at build time; serving is just React.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = path.join(__dirname, 'pages');
const PORT = Number(process.env.PORT || 5173);

function listPages() {
  if (!fs.existsSync(PAGES_DIR)) return [];
  return fs
    .readdirSync(PAGES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

function loadPage(name) {
  const file = path.join(PAGES_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Safe-embed JSON in an inline <script> (escape the </ that would close it).
function embed(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function indexHtml(pages) {
  const items = pages.length
    ? pages.map((p) => `<li><a href="/p/${p}">${p}</a></li>`).join('')
    : '<li class="muted">No pages yet — run <code>loom generate "a SaaS landing page" -o pages/home.json</code></li>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Loom</title>
<style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:640px;margin:64px auto;padding:0 24px;color:#0f172a}
h1{font-size:28px}a{color:#4f46e5}.muted{color:#64748b}code{background:#f1f5f9;padding:2px 6px;border-radius:6px;font-size:14px}
li{margin:6px 0}.tag{color:#4f46e5;font-weight:700}</style></head>
<body><h1>🧵 <span class="tag">Loom</span></h1><p class="muted">AI-authored UI trees, rendered as React.</p>
<h2>Pages</h2><ul>${items}</ul></body></html>`;
}

async function main() {
  const vite = await createViteServer({
    root: __dirname,
    server: { middlewareMode: true },
    appType: 'custom',
  });

  const server = http.createServer((req, res) => {
    vite.middlewares(req, res, async () => {
      try {
        const url = req.url.split('?')[0];

        if (url === '/' || url === '') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end(indexHtml(listPages()));
        }

        const match = url.match(/^\/p\/([\w-]+)\/?$/);
        if (match) {
          const tree = loadPage(match[1]);
          if (!tree) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            return res.end(`<h1>404</h1><p>No page "${match[1]}".</p>`);
          }

          // 1. SSR the tree. 2. Inject HTML + serialized tree into the template.
          const { render } = await vite.ssrLoadModule('/src/entry-server.jsx');
          const { html, errors } = render(tree);
          if (errors.length) console.warn(`  [loom] ${errors.length} render warning(s) on /p/${match[1]}`);

          let template = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
          template = await vite.transformIndexHtml(url, template);
          const out = template
            .replace('<!--app-html-->', html)
            .replace('<!--loom-state-->', `<script>window.__LOOM_TREE__ = ${embed(tree)}</script>`);

          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end(out);
        }

        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404</h1>');
      } catch (err) {
        vite.ssrFixStacktrace(err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.stack || String(err));
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`\n  🧵 Loom dev server  →  http://localhost:${PORT}`);
    console.log(`  Pages: ${listPages().map((p) => `/p/${p}`).join('  ') || '(none yet)'}\n`);
  });
}

main();
