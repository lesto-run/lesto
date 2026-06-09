'use strict';

const { underscore } = require('./inflector');

// The base controller. One instance is created per request. Actions read
// `this.params`, set instance variables for the view, and finish by calling
// render() / redirect() / json() / head().
//
//   class PostsController extends Controller {
//     index() {
//       this.posts = Post.all();
//       this.render('posts/index');   // or just this.render() to infer
//     }
//   }
//
class Controller {
  constructor(context) {
    this.request = context.request;
    this.response = context.response;
    this.params = context.params;
    this.router = context.router;
    this.views = context.views;
    this.flash = context.flash || {};
    this._rendered = false;
    this._body = null;
    this._status = 200;
    this._headers = { 'Content-Type': 'text/html; charset=utf-8' };
    this._actionName = null;
  }

  // Called by the dispatcher. Runs before-actions, then the action, supporting
  // the Rails convention of implicit rendering ("posts/index").
  async _process(actionName) {
    this._actionName = actionName;
    await this._runFilters('before');
    if (!this._rendered) {
      await this[actionName]();
    }
    await this._runFilters('after');
    if (!this._rendered) {
      // Implicit render of <controller>/<action>.
      this.render(`${this._controllerPath()}/${actionName}`);
    }
    return { status: this._status, headers: this._headers, body: this._body };
  }

  // ---- filters (before_action / after_action) ----
  // Declare via:  static before = ['requireLogin'];  static after = [...]
  async _runFilters(kind) {
    const filters = this.constructor[kind] || [];
    for (const f of filters) {
      if (this._rendered && kind === 'before') break;
      const fn = typeof f === 'function' ? f : this[f];
      if (typeof fn === 'function') await fn.call(this);
    }
  }

  _controllerPath() {
    // PostsController -> "posts"; Admin::UsersController not supported (flat).
    return underscore(this.constructor.name.replace(/Controller$/, ''));
  }

  // ---- rendering ----
  render(template, locals = {}, opts = {}) {
    if (typeof template === 'object') {
      // render({ json: {...} }) / render({ text: '...' }) / render({ status })
      return this._renderSpecial(template);
    }
    const tmpl = template || `${this._controllerPath()}/${this._actionName}`;
    const viewLocals = { ...this._ivars(), ...locals, flash: this.flash, params: this.params };
    this._body = this.views.render(tmpl, viewLocals, opts);
    this._finishHtml();
  }

  _renderSpecial(o) {
    if (o.status) this._status = o.status;
    if (o.json !== undefined) return this.json(o.json, o.status || this._status);
    if (o.text !== undefined) {
      this._headers['Content-Type'] = 'text/plain; charset=utf-8';
      this._body = String(o.text);
      this._rendered = true;
      return;
    }
    if (o.html !== undefined) {
      this._body = String(o.html);
      this._finishHtml();
      return;
    }
    if (o.nothing) return this.head(o.status || 204);
  }

  json(obj, status = 200) {
    this._status = status;
    this._headers['Content-Type'] = 'application/json; charset=utf-8';
    this._body = JSON.stringify(obj, (k, v) => (v && v.toJSON ? v.toJSON() : v));
    this._rendered = true;
  }

  redirect(location, opts = {}) {
    this._status = opts.status || 302;
    this._headers['Location'] = location;
    if (opts.flash) Object.assign(this.flash, opts.flash);
    this._body = '';
    this._rendered = true;
  }

  head(status) {
    this._status = status;
    this._body = '';
    this._rendered = true;
  }

  _finishHtml() {
    this._rendered = true;
  }

  // Collect instance variables the action set, to expose to the view.
  _ivars() {
    const reserved = new Set([
      'request', 'response', 'params', 'router', 'views', 'flash',
      'constructor',
    ]);
    const out = {};
    for (const key of Object.keys(this)) {
      if (!key.startsWith('_') && !reserved.has(key)) out[key] = this[key];
    }
    return out;
  }
}

module.exports = { Controller };
