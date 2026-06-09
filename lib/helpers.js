'use strict';

const { escapeHtml } = require('./view');
const { humanize } = require('./inflector');

// View helpers injected into every template. Bound to the active router so
// path helpers resolve named routes.
function buildHelpers(router) {
  const h = {};

  // pathFor('post', { id: 3 }) -> "/posts/3"; or pathFor('post', postRecord)
  h.pathFor = (name, params = {}) => {
    if (params && typeof params === 'object' && params.attributes) {
      params = { id: params.id };
    }
    return router.pathFor(name, params);
  };

  // linkTo('Edit', '/posts/3/edit', { class: 'btn' })
  h.linkTo = (text, href, attrs = {}) => {
    const a = attrsToString({ href, ...attrs });
    return `<a ${a}>${escapeHtml(text)}</a>`;
  };

  // buttonTo('Delete', '/posts/3', { method: 'delete' }) -> a tiny POST form
  // with method spoofing, the Rails trick for non-GET links.
  h.buttonTo = (text, action, opts = {}) => {
    const method = (opts.method || 'post').toUpperCase();
    const real = method === 'GET' || method === 'POST' ? method : 'POST';
    const spoof = real !== method ? `<input type="hidden" name="_method" value="${method}">` : '';
    return `<form action="${escapeHtml(action)}" method="${real}" style="display:inline">${spoof}<button type="submit">${escapeHtml(text)}</button></form>`;
  };

  // formFor(record, { url, method }, (f) => ...) — yields a form builder.
  h.formFor = (record, opts, fn) => {
    const method = (opts.method || (record && record.isPersisted ? 'PATCH' : 'POST')).toUpperCase();
    const real = method === 'POST' ? 'POST' : 'POST';
    const spoof = method !== 'POST' && method !== 'GET' ? `<input type="hidden" name="_method" value="${method}">` : '';
    const builder = new FormBuilder(record);
    const inner = fn(builder);
    return `<form action="${escapeHtml(opts.url)}" method="${real}">${spoof}${inner}</form>`;
  };

  h.escape = escapeHtml;
  h.humanize = humanize;
  h.truncate = (str, n = 80) => (String(str || '').length > n ? String(str).slice(0, n) + '…' : String(str || ''));
  h.timeAgo = (iso) => {
    if (!iso) return '';
    const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [name, s] of units) {
      const v = Math.floor(secs / s);
      if (v >= 1) return `${v} ${name}${v > 1 ? 's' : ''} ago`;
    }
    return 'just now';
  };

  return h;
}

// A minimal form builder: f.label(), f.textField(), f.textArea(), f.submit().
class FormBuilder {
  constructor(record) {
    this.record = record;
  }
  _value(field) {
    return this.record ? this.record[field] : undefined;
  }
  label(field, text) {
    return `<label for="${field}">${escapeHtml(text || humanize(field))}</label>`;
  }
  textField(field, attrs = {}) {
    return `<input type="text" name="${field}" id="${field}" value="${escapeHtml(this._value(field) ?? '')}" ${attrsToString(attrs)}>`;
  }
  textArea(field, attrs = {}) {
    return `<textarea name="${field}" id="${field}" ${attrsToString(attrs)}>${escapeHtml(this._value(field) ?? '')}</textarea>`;
  }
  checkBox(field) {
    const checked = this._value(field) ? 'checked' : '';
    return `<input type="hidden" name="${field}" value="0"><input type="checkbox" name="${field}" id="${field}" value="1" ${checked}>`;
  }
  numberField(field, attrs = {}) {
    return `<input type="number" name="${field}" id="${field}" value="${escapeHtml(this._value(field) ?? '')}" ${attrsToString(attrs)}>`;
  }
  submit(text = 'Save') {
    return `<button type="submit">${escapeHtml(text)}</button>`;
  }
}

function attrsToString(attrs) {
  return Object.entries(attrs)
    .filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}="${escapeHtml(v)}"`))
    .join(' ');
}

module.exports = { buildHelpers, FormBuilder };
