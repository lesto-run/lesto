'use strict';

const fs = require('fs');
const path = require('path');

// A small ERB-flavoured template engine. Templates are *.html.ejs files:
//
//   <h1><%= post.title %></h1>          <!-- escaped output -->
//   <%- rawHtmlString %>                 <!-- unescaped output -->
//   <% for (const c of comments) { %>    <!-- control flow -->
//     <li><%= c.body %></li>
//   <% } %>
//
// Locals passed to render() are in scope. Helpers (linkTo, pathFor, formFor…)
// are injected too. A layout wraps the rendered view via <%- yield %>.

const cache = new Map();

function compile(source) {
  if (cache.has(source)) return cache.get(source);

  let code = "let __out = '';\n";
  let cursor = 0;
  const re = /<%(=|-|#)?([\s\S]*?)%>/g;
  let m;
  while ((m = re.exec(source))) {
    code += pushLiteral(source.slice(cursor, m.index));
    const [, kind, expr] = m;
    if (kind === '=') code += `__out += __esc(${expr.trim()});\n`;
    else if (kind === '-') code += `__out += (${expr.trim()});\n`;
    else if (kind === '#') { /* comment, emit nothing */ }
    else code += expr + '\n';
    cursor = re.lastIndex;
  }
  code += pushLiteral(source.slice(cursor));
  code += 'return __out;';

  // Trust boundary: `code` is derived ONLY from developer-authored template
  // files on disk (the same trust level as the app's own .js source), exactly
  // like EJS/ERB/Pug compilation. Untrusted request data never reaches this
  // string — it arrives later as the `__ctx` *argument* and is HTML-escaped via
  // `__esc` on output. Never compile a string built from request input here.
  // eslint-disable-next-line no-new-func
  const fn = new Function('__ctx', '__esc', `with (__ctx) {\n${code}\n}`);
  cache.set(source, fn);
  return fn;
}

function pushLiteral(str) {
  if (!str) return '';
  return `__out += ${JSON.stringify(str)};\n`;
}

function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class ViewRenderer {
  constructor(viewsDir, helpers = {}) {
    this.viewsDir = viewsDir;
    this.helpers = helpers;
  }

  _read(relPath) {
    const full = path.join(this.viewsDir, `${relPath}.html.ejs`);
    if (!fs.existsSync(full)) throw new Error(`Missing template: ${full}`);
    return fs.readFileSync(full, 'utf8');
  }

  // Render "posts/index" with locals, wrapped in a layout (default: layouts/application).
  render(templatePath, locals = {}, opts = {}) {
    const ctx = { ...this.helpers, ...locals };

    // `render('partial', {...})` available inside templates.
    ctx.render = (p, partialLocals = {}) =>
      this.renderTemplate(resolvePartial(p), { ...ctx, ...partialLocals });

    const body = this.renderTemplate(templatePath, ctx);

    const layoutName = opts.layout === false ? null : opts.layout || 'layouts/application';
    if (!layoutName) return body;
    const layoutFull = path.join(this.viewsDir, `${layoutName}.html.ejs`);
    if (!fs.existsSync(layoutFull)) return body;
    return this.renderTemplate(layoutName, { ...ctx, yield: body });
  }

  renderTemplate(templatePath, ctx) {
    const source = this._read(templatePath);
    const fn = compile(source);
    return fn(ctx, escapeHtml);
  }
}

// "comment" inside "posts/show" -> "posts/_comment"; "posts/comment" -> "posts/_comment"
function resolvePartial(p) {
  const parts = p.split('/');
  parts[parts.length - 1] = '_' + parts[parts.length - 1];
  return parts.join('/');
}

module.exports = { ViewRenderer, compile, escapeHtml };
