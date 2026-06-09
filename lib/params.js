'use strict';

// Parses a request body + query string into a single params object, and
// supports Rails-style nested params: post[title]=Hi&post[body]=Yo becomes
// { post: { title: 'Hi', body: 'Yo' } }.

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 5 * 1024 * 1024; // 5MB guard
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(raw, contentType = '') {
  if (!raw) return {};
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  // default: application/x-www-form-urlencoded
  return expandNested(parseUrlEncoded(raw));
}

function parseUrlEncoded(raw) {
  const out = [];
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    const key = decodeURIComponent((idx === -1 ? pair : pair.slice(0, idx)).replace(/\+/g, ' '));
    const val = idx === -1 ? '' : decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    out.push([key, val]);
  }
  return out;
}

// Expand "post[title]" bracket keys into nested objects.
function expandNested(pairs) {
  const result = {};
  for (const [key, val] of pairs) {
    const match = key.match(/^([^\[]+)((\[[^\]]*\])*)$/);
    if (!match || !match[2]) {
      result[key] = val;
      continue;
    }
    const root = match[1];
    const path = [...match[2].matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
    let node = (result[root] ||= {});
    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      const last = i === path.length - 1;
      if (last) {
        node[seg] = val;
      } else {
        node = node[seg] ||= {};
      }
    }
  }
  return result;
}

function parseQuery(search) {
  if (!search) return {};
  return expandNested(parseUrlEncoded(search.replace(/^\?/, '')));
}

module.exports = { readBody, parseBody, parseQuery, expandNested };
