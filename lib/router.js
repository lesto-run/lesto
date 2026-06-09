'use strict';

const { singularize } = require('./inflector');

// The routing DSL. In config/routes.js:
//
//   module.exports = (r) => {
//     r.root('posts#index');
//     r.resources('posts');                 // the 7 RESTful routes
//     r.resources('posts', (p) => {         // nested
//       p.resources('comments');
//     });
//     r.get('/about', 'pages#about');
//     r.post('/login', 'sessions#create');
//   };
//
// Each route maps METHOD + path-pattern -> "controller#action".

const RESOURCE_ROUTES = [
  { action: 'index', method: 'GET', suffix: '' },
  { action: 'new', method: 'GET', suffix: '/new' },
  { action: 'create', method: 'POST', suffix: '' },
  { action: 'show', method: 'GET', suffix: '/:id' },
  { action: 'edit', method: 'GET', suffix: '/:id/edit' },
  { action: 'update', method: 'PATCH', suffix: '/:id' },
  { action: 'update', method: 'PUT', suffix: '/:id' },
  { action: 'destroy', method: 'DELETE', suffix: '/:id' },
];

class Route {
  constructor(method, pattern, controller, action, name) {
    this.method = method;
    this.pattern = pattern;
    this.controller = controller;
    this.action = action;
    this.name = name;
    this.regex = compile(pattern);
  }

  match(method, pathname) {
    if (method !== this.method) return null;
    const m = this.regex.exec(pathname);
    if (!m) return null;
    return m.groups ? { ...m.groups } : {};
  }
}

// "/posts/:id/edit" -> /^\/posts\/(?<id>[^/]+)\/edit$/
function compile(pattern) {
  const src = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === ':' ? c : '\\' + c))
    .replace(/:([a-zA-Z_]+)/g, '(?<$1>[^/]+)');
  return new RegExp(`^${src}$`);
}

class Router {
  constructor() {
    this.routes = [];
    this.named = {};
  }

  // ---- low-level verbs ----
  match(method, path, target, opts = {}) {
    const [controller, action] = target.split('#');
    const route = new Route(method, path, controller, action, opts.as);
    this.routes.push(route);
    if (opts.as) this.named[opts.as] = path;
    return route;
  }
  get(path, target, opts) { return this.match('GET', path, target, opts); }
  post(path, target, opts) { return this.match('POST', path, target, opts); }
  patch(path, target, opts) { return this.match('PATCH', path, target, opts); }
  put(path, target, opts) { return this.match('PUT', path, target, opts); }
  delete(path, target, opts) { return this.match('DELETE', path, target, opts); }

  root(target) {
    return this.match('GET', '/', target, { as: 'root' });
  }

  // ---- RESTful resources ----
  // prefix carries nesting context, e.g. "/posts/:post_id".
  resources(name, fnOrPrefix, maybeFn) {
    let prefix = '';
    let fn = null;
    if (typeof fnOrPrefix === 'function') fn = fnOrPrefix;
    else if (typeof fnOrPrefix === 'string') {
      prefix = fnOrPrefix;
      fn = maybeFn;
    }

    const base = `${prefix}/${name}`;
    const singular = singularize(name);

    for (const r of RESOURCE_ROUTES) {
      const path = base + r.suffix;
      const as =
        r.action === 'index' ? name :
        r.action === 'show' ? singular :
        r.action === 'new' ? `new_${singular}` :
        r.action === 'edit' ? `edit_${singular}` :
        null;
      this.match(r.method, path, `${name}#${r.action}`, as ? { as: prefixName(prefix, as) } : {});
    }

    // Nested resources get the parent's :id renamed to :<singular>_id.
    if (fn) {
      const nestedPrefix = `${base}/:${singular}_id`;
      const scoped = scopedRouter(this, nestedPrefix);
      fn(scoped);
    }
  }

  resolve(method, pathname) {
    for (const route of this.routes) {
      const params = route.match(method, pathname);
      if (params) return { route, params };
    }
    return null;
  }

  // Generate a path from a named route: pathFor('post', { id: 3 }) -> "/posts/3"
  pathFor(name, params = {}) {
    const pattern = this.named[name];
    if (!pattern) throw new Error(`No named route: ${name}`);
    return pattern.replace(/:([a-zA-Z_]+)/g, (_, key) => {
      if (params[key] == null) throw new Error(`Missing param "${key}" for route "${name}"`);
      return encodeURIComponent(params[key]);
    });
  }

  list() {
    return this.routes.map((r) => ({
      method: r.method,
      pattern: r.pattern,
      to: `${r.controller}#${r.action}`,
      name: r.name,
    }));
  }
}

function prefixName(prefix, as) {
  if (!prefix) return as;
  // "/posts/:post_id" -> "post_<as>" for nested named routes
  const seg = prefix.split('/').filter(Boolean).find((s) => !s.startsWith(':'));
  return seg ? `${singularize(seg)}_${as}` : as;
}

// A view over the same router that injects a path prefix for nested resources.
function scopedRouter(router, prefix) {
  return new Proxy(router, {
    get(target, prop) {
      if (prop === 'resources') {
        return (name, fnOrPrefix, maybeFn) => {
          if (typeof fnOrPrefix === 'function') return target.resources(name, prefix, fnOrPrefix);
          return target.resources(name, prefix, maybeFn);
        };
      }
      if (['get', 'post', 'patch', 'put', 'delete'].includes(prop)) {
        return (path, t, opts) => target[prop](prefix + path, t, opts);
      }
      return target[prop];
    },
  });
}

function draw(fn) {
  const router = new Router();
  fn(router);
  return router;
}

module.exports = { Router, Route, draw };
