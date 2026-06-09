'use strict';

const crypto = require('crypto');
const database = require('./database');

// Data masking for safe local development. The workflow Keel targets: pull a
// copy of production data into your local/staging DB with PII masked, so you
// develop against realistic-shaped data without handling real personal data.
//
// Maskers are DETERMINISTIC — the same input always yields the same masked
// output — so referential integrity is preserved (a user's email masks to the
// same value everywhere it appears) and tests are stable. No Math.random.

function digest(value, n = 8) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, n);
}

const FIRST = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Quinn'];
const LAST = ['Reed', 'Stone', 'Vale', 'Frost', 'Lake', 'Cross', 'Hart', 'Day', 'Fox', 'Pine'];

function pick(list, value) {
  return list[parseInt(digest(value, 6), 16) % list.length];
}

// Built-in maskers. Each: (value) => maskedValue. Null/empty passes through.
const MASKERS = {
  email: (v) => (v ? `user_${digest(v)}@example.com` : v),
  name: (v) => (v ? pick(FIRST, v) : v),
  fullName: (v) => (v ? `${pick(FIRST, v)} ${pick(LAST, v + 'x')}` : v),
  phone: (v) => (v ? `555-01${digest(v, 2).replace(/\D/g, '0').padStart(2, '0').slice(0, 2)}` : v),
  hash: (v) => (v == null ? v : digest(v, 16)),
  redact: () => '████████',
  keep: (v) => v,
};

function maskValue(value, type) {
  const masker = typeof type === 'function' ? type : MASKERS[type];
  if (!masker) throw new Error(`Unknown masker: ${type}`);
  return masker(value);
}

// Mask a table in place. `rules` maps column -> masker name|fn.
//   maskTable(db, 'users', { email: 'email', full_name: 'fullName', ssn: 'redact' })
function maskTable(db, table, rules) {
  const cols = Object.keys(rules);
  const rows = db.prepare(`SELECT rowid AS _rid, ${cols.join(', ')} FROM ${table}`).all();
  const set = cols.map((c) => `${c}=@${c}`).join(', ');
  const stmt = db.prepare(`UPDATE ${table} SET ${set} WHERE rowid=@_rid`);
  const tx = db.transaction((all) => {
    for (const row of all) {
      const update = { _rid: row._rid };
      for (const c of cols) update[c] = maskValue(row[c], rules[c]);
      stmt.run(update);
    }
  });
  tx(rows);
  return rows.length;
}

// Apply a whole masking config: { tableName: { col: masker, ... }, ... }
function maskDatabase(config, db = database.db()) {
  const counts = {};
  for (const [table, rules] of Object.entries(config)) {
    counts[table] = maskTable(db, table, rules);
  }
  return counts;
}

module.exports = { MASKERS, maskValue, maskTable, maskDatabase };
