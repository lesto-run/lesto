import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer as createViteServer } from 'vite';

// LESTO — the unified fullstack runtime (prototype).
//
// One server that owns BOTH halves of the stack:
//   • the Tracks ORM (Rails-like, CommonJS) — talks to SQLite
//   • Loom (Next-like, ESM/Vite) — SSR + hydrated React
//
// A request to /posts runs through the backend (query the DB via the ORM) and
// the frontend (render the rows as a Loom UI tree → React → SSR HTML + hydrate)
// in a single process. This is the Rails⋈Next spine of the framework.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Tracks = require('../lib/index.js'); // CJS backend, imported into the ESM runtime
const PORT = Number(process.env.PORT || 5200);

// ---- Backend: boot the ORM, define a model, ensure schema + seed data --------
Tracks.database.connect(__dirname, 'lesto');
const db = Tracks.database.db();
db.exec(`CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT,
  author TEXT,
  created_at TEXT,
  updated_at TEXT
)`);

class Post extends Tracks.Model {
  static validations = { title: { presence: true } };
}

if (Post.count() === 0) {
  Post.create({ title: 'It compiles', body: 'Rows from SQLite, rendered as React.', author: 'Ada' });
  Post.create({ title: 'One server, both halves', body: 'The ORM and the renderer share a process.', author: 'Grace' });
  Post.create({ title: 'AI-native by design', body: 'The same UI tree could be model-generated.', author: 'Linus' });
}

// ---- Frontend: turn ORM records into a Loom UI tree --------------------------
function postsPage(posts) {
  return {
    type: 'Page',
    props: { title: 'Lesto — Posts' },
    children: [
      {
        type: 'Hero',
        props: {
          eyebrow: 'LESTO · TRACKS ⋈ LOOM',
          title: 'Posts',
          subtitle: `${posts.length} record(s) loaded from SQLite via the Tracks ORM, rendered as server-side React.`,
        },
      },
      {
        type: 'Stack',
        props: { gap: 4 },
        children: posts.map((p) => ({
          type: 'Card',
          children: [
            { type: 'Heading', props: { text: p.title, level: '3' } },
            { type: 'Text', props: { text: p.body || '', tone: 'muted' } },
            { type: 'Badge', props: { text: `by ${p.author || 'anon'}` } },
          ],
        })),
      },
    ],
  };
}

function embed(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

async function main() {
  const vite = await createViteServer({
    root: __dirname,
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });

  const server = http.createServer((req, res) => {
    vite.middlewares(req, res, async () => {
      try {
        const url = req.url.split('?')[0];

        // Backend route: query the ORM, render through the frontend.
        if (url === '/' || url === '/posts') {
          const posts = Post.order('created_at', 'desc').all().map((p) => p.toJSON());
          const tree = postsPage(posts);

          const { render } = await vite.ssrLoadModule('/src/entry-server.jsx');
          const { html } = render(tree); // Loom: UI tree → React → HTML

          let template = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
          template = await vite.transformIndexHtml(url, template);
          const out = template
            .replace('<!--app-html-->', html)
            .replace('<!--loom-state-->', `<script>window.__LOOM_TREE__ = ${embed(tree)}</script>`);

          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end(out);
        }

        // JSON API route — same data, headless (the Next-style API surface).
        if (url === '/api/posts') {
          const posts = Post.order('created_at', 'desc').all().map((p) => p.toJSON());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(posts, null, 2));
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
    console.log(`\n  ⚓ Lesto runtime  →  http://localhost:${PORT}`);
    console.log(`  Backend:  Tracks ORM + SQLite (${Post.count()} posts)`);
    console.log(`  Frontend: Loom SSR React + hydration`);
    console.log(`  Routes:   /posts (SSR page) · /api/posts (JSON)\n`);
  });
}

main();
