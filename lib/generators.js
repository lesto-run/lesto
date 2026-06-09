'use strict';

const fs = require('fs');
const path = require('path');
const inflector = require('./inflector');
const { camelize, underscore, pluralize, singularize, tableize, humanize } = inflector;

// Code generators. Each returns the list of files it wrote/edited so the CLI
// can print the familiar `create  app/models/post.js` output.

const log = [];
function write(root, rel, contents, { force = false } = {}) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const exists = fs.existsSync(full);
  if (exists && !force) {
    log.push(['exist', rel]);
    return full;
  }
  fs.writeFileSync(full, contents);
  log.push([exists ? 'force' : 'create', rel]);
  return full;
}
function flushLog() {
  const out = log.splice(0);
  return out;
}

// Parse "title:string body:text published:boolean user:references" field specs.
function parseFields(specs) {
  return specs.map((s) => {
    const [name, type = 'string'] = s.split(':');
    return { name, type, reference: type === 'references' || type === 'belongs_to' };
  });
}

// A numeric, sortable migration version. Caller passes a seed so runs are
// deterministic/orderable without Date.now (which is unavailable in some envs).
function version(seed) {
  return String(seed).padStart(14, '0');
}

// ---------- new application ----------
function newApp(root, name) {
  const appName = name;

  write(root, 'package.json', JSON.stringify({
    name: underscore(appName),
    version: '0.1.0',
    private: true,
    scripts: {
      server: 'tracks server',
      migrate: 'tracks db:migrate',
      console: 'tracks console',
    },
    dependencies: { tracks: '^0.1.0' },
  }, null, 2) + '\n');

  write(root, 'config/routes.js',
`// Define your application's routes here.
// See \`tracks routes\` for the full list once you've added some.

module.exports = (r) => {
  r.root('welcome#index');

  // r.resources('posts');
  // r.get('/about', 'pages#about');
};
`);

  write(root, 'config/application.js',
`// App-wide configuration. Currently a placeholder for future settings.
module.exports = {
  name: ${JSON.stringify(appName)},
};
`);

  // A welcome controller + view so \`tracks server\` shows something immediately.
  write(root, 'app/controllers/WelcomeController.js',
`const { Controller } = require('tracks');

class WelcomeController extends Controller {
  index() {
    this.render('welcome/index');
  }
}

module.exports = WelcomeController;
`);

  write(root, 'app/views/layouts/application.html.ejs', layoutTemplate(appName));
  write(root, 'app/views/welcome/index.html.ejs', welcomeTemplate(appName));
  write(root, 'public/application.css', applicationCss());
  write(root, 'public/favicon.ico', '');
  write(root, '.gitignore', 'node_modules\ndb/*.sqlite3\ndb/*.sqlite3-*\n');
  write(root, 'README.md', readmeTemplate(appName));

  return flushLog();
}

// ---------- model + migration ----------
function generateModel(root, rawName, fieldSpecs, opts = {}) {
  const className = camelize(singularize(rawName));
  const fields = parseFields(fieldSpecs);

  write(root, `app/models/${className}.js`, modelTemplate(className, fields));

  if (opts.migration !== false) {
    const table = tableize(className);
    write(root, `db/migrate/${version(opts.seed || 1)}_create_${table}.js`,
      createTableMigration(table, fields));
  }
  return flushLog();
}

// ---------- controller ----------
function generateController(root, rawName, actions = []) {
  const resource = underscore(pluralize(rawName));
  const className = `${camelize(resource)}Controller`;
  write(root, `app/controllers/${className}.js`, controllerTemplate(className, actions, resource));
  for (const a of actions) {
    write(root, `app/views/${resource}/${a}.html.ejs`, `<h1>${camelize(resource)}#${a}</h1>\n`);
  }
  return flushLog();
}

// ---------- scaffold (the big one) ----------
function generateScaffold(root, rawName, fieldSpecs, opts = {}) {
  const model = camelize(singularize(rawName));
  const resource = tableize(model);           // "posts"
  const singular = singularize(resource);     // "post"
  const fields = parseFields(fieldSpecs);

  // model + migration
  write(root, `app/models/${model}.js`, modelTemplate(model, fields, { scaffold: true }));
  write(root, `db/migrate/${version(opts.seed || 1)}_create_${resource}.js`,
    createTableMigration(resource, fields));

  // controller
  write(root, `app/controllers/${camelize(resource)}Controller.js`,
    scaffoldControllerTemplate(model, resource, singular, fields));

  // views
  write(root, `app/views/${resource}/index.html.ejs`, scaffoldIndexView(model, resource, singular, fields));
  write(root, `app/views/${resource}/show.html.ejs`, scaffoldShowView(model, resource, singular, fields));
  write(root, `app/views/${resource}/new.html.ejs`, scaffoldNewView(model, resource, singular));
  write(root, `app/views/${resource}/edit.html.ejs`, scaffoldEditView(model, resource, singular));
  write(root, `app/views/${resource}/_form.html.ejs`, scaffoldFormPartial(model, resource, singular, fields));

  // route injection
  injectResourceRoute(root, resource);

  return flushLog();
}

// Insert `r.resources('posts');` into config/routes.js if not present.
function injectResourceRoute(root, resource) {
  const file = path.join(root, 'config', 'routes.js');
  if (!fs.existsSync(file)) return;
  let src = fs.readFileSync(file, 'utf8');
  const line = `  r.resources('${resource}');`;
  // Only consider *active* (non-commented) route lines so the commented
  // examples in the default routes file don't block injection.
  const active = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  if (new RegExp(`resources\\(['"]${resource}['"]\\)`).test(active)) {
    log.push(['exist', 'config/routes.js']);
    return;
  }
  // Insert after the opening of the exported function.
  src = src.replace(/(module\.exports\s*=\s*\(r\)\s*=>\s*\{\n)/, `$1${line}\n`);
  fs.writeFileSync(file, src);
  log.push(['route', `resources '${resource}'`]);
}

// ================= templates =================

function modelTemplate(className, fields, opts = {}) {
  const refs = fields.filter((f) => f.reference);
  const assoc = refs.length
    ? `\n  static associations = {\n${refs
        .map((f) => `    ${underscore(f.name)}: { belongsTo: '${camelize(f.name)}' },`)
        .join('\n')}\n  };\n`
    : '';
  const firstText = fields.find((f) => !f.reference);
  const validations = firstText
    ? `\n  static validations = {\n    ${firstText.name}: { presence: true },\n  };\n`
    : '';
  return `const { Model } = require('tracks');

class ${className} extends Model {${validations}${assoc}}

module.exports = ${className};
`;
}

function createTableMigration(table, fields) {
  const lines = fields.map((f) => {
    if (f.reference) return `      t.references('${underscore(f.name)}');`;
    return `      t.${f.type}('${f.name}');`;
  });
  return `module.exports = {
  up(schema) {
    schema.createTable('${table}', (t) => {
${lines.join('\n')}
      t.timestamps();
    });
  },

  down(schema) {
    schema.dropTable('${table}');
  },
};
`;
}

function controllerTemplate(className, actions, resource) {
  const methods = actions.map((a) => `  ${a}() {\n    this.render('${resource}/${a}');\n  }`).join('\n\n');
  return `const { Controller } = require('tracks');

class ${className} extends Controller {
${methods || '  // add actions here'}
}

module.exports = ${className};
`;
}

function scaffoldControllerTemplate(model, resource, singular, fields) {
  const writable = fields.map((f) => (f.reference ? `${underscore(f.name)}_id` : f.name));
  const permit = writable.map((f) => `'${f}'`).join(', ');
  return `const { Controller, RecordNotFound } = require('tracks');
const ${model} = require('../models/${model}');

class ${camelize(resource)}Controller extends Controller {
  index() {
    this.${resource} = ${model}.order('created_at', 'desc').all();
  }

  show() {
    this.${singular} = ${model}.find(this.params.id);
  }

  new() {
    this.${singular} = new ${model}();
  }

  create() {
    this.${singular} = new ${model}(this._${singular}Params());
    if (this.${singular}.save()) {
      this.redirect(this.router.pathFor('${singular}', { id: this.${singular}.id }),
        { flash: { notice: '${model} was successfully created.' } });
    } else {
      this.render('${resource}/new');
    }
  }

  edit() {
    this.${singular} = ${model}.find(this.params.id);
  }

  update() {
    this.${singular} = ${model}.find(this.params.id);
    if (this.${singular}.update(this._${singular}Params())) {
      this.redirect(this.router.pathFor('${singular}', { id: this.${singular}.id }),
        { flash: { notice: '${model} was successfully updated.' } });
    } else {
      this.render('${resource}/edit');
    }
  }

  destroy() {
    ${model}.find(this.params.id).destroy();
    this.redirect(this.router.pathFor('${resource}'),
      { flash: { notice: '${model} was successfully destroyed.' } });
  }

  // Strong-params: only these keys are mass-assignable.
  _${singular}Params() {
    const permitted = [${permit}];
    const source = this.params.${singular} || this.params;
    const out = {};
    for (const key of permitted) if (key in source) out[key] = source[key];
    return out;
  }
}

module.exports = ${camelize(resource)}Controller;
`;
}

function fieldDisplay(f, varName) {
  return `<%= ${varName}.${f.reference ? underscore(f.name) + '_id' : f.name} %>`;
}

function scaffoldIndexView(model, resource, singular, fields) {
  const cols = fields.map((f) => `        <th>${humanize(f.name)}</th>`).join('\n');
  const cells = fields.map((f) => `        <td>${fieldDisplay(f, singular)}</td>`).join('\n');
  return `<% if (flash.notice) { %><p class="notice"><%= flash.notice %></p><% } %>

<div class="header-row">
  <h1>${humanize(resource)}</h1>
  <%- linkTo('New ${humanize(singular)}', pathFor('new_${singular}'), { class: 'btn' }) %>
</div>

<table>
  <thead>
    <tr>
${cols}
      <th></th>
    </tr>
  </thead>
  <tbody>
    <% for (const ${singular} of ${resource}) { %>
      <tr>
${cells}
        <td class="actions">
          <%- linkTo('Show', pathFor('${singular}', { id: ${singular}.id })) %>
          <%- linkTo('Edit', pathFor('edit_${singular}', { id: ${singular}.id })) %>
          <%- buttonTo('Delete', pathFor('${singular}', { id: ${singular}.id }), { method: 'delete' }) %>
        </td>
      </tr>
    <% } %>
  </tbody>
</table>

<% if (${resource}.length === 0) { %><p class="empty">No ${resource} yet.</p><% } %>
`;
}

function scaffoldShowView(model, resource, singular, fields) {
  const rows = fields.map(
    (f) => `  <p><strong>${humanize(f.name)}:</strong> ${fieldDisplay(f, singular)}</p>`
  ).join('\n');
  return `<% if (flash.notice) { %><p class="notice"><%= flash.notice %></p><% } %>

<h1>${humanize(singular)}</h1>

${rows}

<div class="actions">
  <%- linkTo('Edit', pathFor('edit_${singular}', { id: ${singular}.id }), { class: 'btn' }) %>
  <%- linkTo('Back', pathFor('${resource}')) %>
  <%- buttonTo('Delete', pathFor('${singular}', { id: ${singular}.id }), { method: 'delete' }) %>
</div>
`;
}

function scaffoldNewView(model, resource, singular) {
  return `<h1>New ${humanize(singular)}</h1>

<%- render('${resource}/form', { ${singular}: ${singular}, url: pathFor('${resource}'), method: 'post' }) %>

<%- linkTo('Back', pathFor('${resource}')) %>
`;
}

function scaffoldEditView(model, resource, singular) {
  return `<h1>Edit ${humanize(singular)}</h1>

<%- render('${resource}/form', { ${singular}: ${singular}, url: pathFor('${singular}', { id: ${singular}.id }), method: 'patch' }) %>

<%- linkTo('Back', pathFor('${resource}')) %>
`;
}

function scaffoldFormPartial(model, resource, singular, fields) {
  // NB: these lines live INSIDE the JS template literal handed to formFor(),
  // so they use ${...} interpolation — not <%- %> tags, which only work at the
  // top level of an .ejs template.
  const inputs = fields.map((f) => {
    const name = f.reference ? `${underscore(f.name)}_id` : f.name;
    let field;
    if (f.type === 'text') field = `f.textArea('${name}')`;
    else if (f.type === 'boolean') field = `f.checkBox('${name}')`;
    else if (['integer', 'bigint', 'float', 'decimal', 'references', 'belongs_to'].includes(f.type)) field = `f.numberField('${name}')`;
    else field = `f.textField('${name}')`;
    return `    <div class="field">
      \${f.label('${name}')}
      \${${field}}
    </div>`;
  }).join('\n');
  return `<% if (${singular}.errors && !${singular}.errors.isEmpty) { %>
  <div class="errors">
    <strong><%= ${singular}.errors.count %> error(s) prohibited this ${singular} from being saved:</strong>
    <ul>
      <% for (const msg of ${singular}.errors.full()) { %><li><%= msg %></li><% } %>
    </ul>
  </div>
<% } %>

<%- formFor(${singular}, { url: url, method: method }, (f) => \`
${inputs}
    <div class="actions">\${f.submit('Save ${humanize(singular)}')}</div>
\`) %>
`;
}

function layoutTemplate(appName) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${appName}</title>
    <link rel="stylesheet" href="/application.css">
  </head>
  <body>
    <nav class="topbar"><a href="/" class="brand">${appName}</a></nav>
    <main class="container">
      <%- yield %>
    </main>
  </body>
</html>
`;
}

function welcomeTemplate(appName) {
  return `<section class="hero">
  <h1>You're riding the <strong>Tracks</strong>. 🛤️</h1>
  <p>${appName} is up and running.</p>
  <p class="muted">Generate your first resource:</p>
  <pre><code>tracks generate scaffold Post title:string body:text published:boolean</code></pre>
  <p class="muted">Then run <code>tracks db:migrate</code> and refresh.</p>
</section>
`;
}

function applicationCss() {
  return `:root { --fg:#1a1a1e; --muted:#6b7280; --accent:#4f46e5; --border:#e5e7eb; --bg:#fafafa; }
* { box-sizing: border-box; }
body { margin:0; font:16px/1.6 -apple-system, system-ui, Segoe UI, Roboto, sans-serif; color:var(--fg); background:var(--bg); }
.topbar { background:#fff; border-bottom:1px solid var(--border); padding:14px 24px; }
.brand { font-weight:700; color:var(--fg); text-decoration:none; font-size:18px; }
.container { max-width:880px; margin:32px auto; padding:0 24px; }
.hero { text-align:center; padding:48px 0; }
.hero h1 { font-size:32px; }
.muted, .empty { color:var(--muted); }
h1 { font-size:26px; }
a { color:var(--accent); }
.btn, button { display:inline-block; background:var(--accent); color:#fff; border:none; padding:8px 14px; border-radius:8px; text-decoration:none; font-size:14px; cursor:pointer; }
.header-row { display:flex; justify-content:space-between; align-items:center; }
table { width:100%; border-collapse:collapse; margin-top:16px; background:#fff; border:1px solid var(--border); border-radius:10px; overflow:hidden; }
th, td { text-align:left; padding:10px 14px; border-bottom:1px solid var(--border); }
th { background:#f9fafb; font-size:13px; text-transform:uppercase; letter-spacing:.03em; color:var(--muted); }
.actions { display:flex; gap:8px; align-items:center; }
.actions a { font-size:14px; }
.actions form button { background:#ef4444; }
.field { margin-bottom:14px; display:flex; flex-direction:column; gap:4px; }
.field input, .field textarea { padding:8px 10px; border:1px solid var(--border); border-radius:8px; font:inherit; }
.notice { background:#ecfdf5; color:#065f46; padding:10px 14px; border-radius:8px; }
.errors { background:#fef2f2; color:#991b1b; padding:12px 16px; border-radius:8px; margin-bottom:16px; }
pre { background:#1e1e22; color:#eee; padding:16px; border-radius:10px; overflow:auto; text-align:left; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;
}

function readmeTemplate(appName) {
  return `# ${appName}

Built with **Tracks** — a full-stack MVC framework for Node.js.

## Get started

    npm install
    tracks db:migrate
    tracks server

Then open http://localhost:3000.

## Generate a resource

    tracks generate scaffold Post title:string body:text published:boolean
    tracks db:migrate

## Commands

    tracks server            # start the dev server
    tracks console           # REPL with your models loaded
    tracks routes            # list all routes
    tracks db:migrate        # run pending migrations
    tracks db:rollback       # undo the last migration
    tracks generate model    NAME field:type ...
    tracks generate controller NAME action ...
    tracks generate scaffold NAME field:type ...
`;
}

module.exports = {
  newApp,
  generateModel,
  generateController,
  generateScaffold,
  parseFields,
};
