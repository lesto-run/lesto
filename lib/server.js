'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { readBody, parseBody, parseQuery } = require('./params');

// The request dispatcher + HTTP server. For each request it:
//   1. serves a matching static file from /public, else
//   2. resolves the route, instantiates the controller, runs the action,
//   3. writes the controller's response.
class Server {
  constructor(app) {
    this.app = app;
  }

  async handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    try {
      if (await this._serveStatic(pathname, res)) {
        return this._log(req, res, pathname, started);
      }

      const raw = ['GET', 'HEAD', 'DELETE'].includes(req.method) ? '' : await readBody(req);
      const body = parseBody(raw, req.headers['content-type'] || '');
      const query = parseQuery(url.search);

      // Method spoofing: forms POST with _method=PATCH/PUT/DELETE.
      let method = req.method;
      if (method === 'POST' && body._method) {
        method = String(body._method).toUpperCase();
        delete body._method;
      }

      const match = this.app.router.resolve(method, pathname);
      if (!match) return this._notFound(res, req, pathname, started);

      const params = { ...query, ...body, ...match.params };
      const ControllerClass = this.app.controllers[match.route.controller];
      if (!ControllerClass) {
        throw new Error(`Unknown controller: ${match.route.controller} (for ${pathname})`);
      }

      const controller = new ControllerClass({
        request: req,
        response: res,
        params,
        router: this.app.router,
        views: this.app.views,
        flash: {},
      });

      const result = await controller._process(match.route.action);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      this._log(req, res, pathname, started, match.route);
    } catch (err) {
      this._error(res, err, req, pathname, started);
    }
  }

  async _serveStatic(pathname, res) {
    if (pathname === '/' || pathname.includes('..')) return false;
    const file = path.join(this.app.root, 'public', pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    res.writeHead(200, { 'Content-Type': contentType(file) });
    res.end(fs.readFileSync(file));
    return true;
  }

  _notFound(res, req, pathname, started) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(errorPage(404, 'Not Found', `No route matches <code>${req.method} ${escape(pathname)}</code>`, this.app));
    this._log(req, res, pathname, started);
  }

  _error(res, err, req, pathname, started) {
    if (res.headersSent) return;
    // A missing record is a 404, not a server error (Rails convention).
    if (err && err.constructor && err.constructor.name === 'RecordNotFound') {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorPage(404, 'Not Found', escape(err.message), this.app));
      return this._log(req, res, pathname, started);
    }
    process.stderr.write(`\n[error] ${err.stack || err}\n`);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    const detail = this.app.env === 'development'
      ? `<pre>${escape(err.stack || String(err))}</pre>`
      : 'Something went wrong.';
    res.end(errorPage(500, 'Internal Server Error', detail, this.app));
    this._log(req, res, pathname, started);
  }

  _log(req, res, pathname, started, route) {
    const ms = Date.now() - started;
    const to = route ? `→ ${route.controller}#${route.action}` : '';
    const color = res.statusCode >= 500 ? 31 : res.statusCode >= 400 ? 33 : 32;
    process.stdout.write(
      `  \x1b[${color}m${res.statusCode}\x1b[0m ${req.method.padEnd(6)} ${pathname} ${to} \x1b[90m(${ms}ms)\x1b[0m\n`
    );
  }

  listen(port, host, cb) {
    this.httpServer = http.createServer((req, res) => this.handle(req, res));
    this.httpServer.listen(port, host, cb);
    return this.httpServer;
  }
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain',
};
function contentType(file) {
  return MIME[path.extname(file)] || 'application/octet-stream';
}

function escape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function errorPage(code, title, detail, app) {
  const routes = app && app.env === 'development'
    ? `<details><summary>Routes</summary><pre>${escape(
        app.router.list().map((r) => `${r.method.padEnd(6)} ${r.pattern}  ${r.to}`).join('\n')
      )}</pre></details>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${code} ${title}</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:820px;margin:60px auto;padding:0 20px;color:#222}
h1{font-size:22px}code{background:#f4f4f5;padding:2px 6px;border-radius:4px}pre{background:#1e1e22;color:#eee;padding:16px;border-radius:8px;overflow:auto}
.badge{display:inline-block;background:#dc2626;color:#fff;border-radius:6px;padding:2px 10px;font-weight:600;font-size:13px}</style></head>
<body><p><span class="badge">${code}</span></p><h1>${title}</h1><div>${detail}</div>${routes}
<hr style="margin-top:40px;border:none;border-top:1px solid #eee"><p style="color:#999;font-size:13px">Tracks</p></body></html>`;
}

module.exports = { Server };
