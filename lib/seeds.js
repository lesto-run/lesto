'use strict';

const fs = require('fs');
const path = require('path');

// First-class seeding. `db/seeds.js` exports a function that receives the app's
// loaded models (+ helpers) and populates the database. Seeds should be
// idempotent — re-running `tracks db:seed` must not duplicate rows — so we ship
// findOrCreate / upsert helpers.

function findOrCreate(Model, where, defaults = {}) {
  const existing = Model.findBy(where);
  if (existing) return existing;
  return Model.create({ ...where, ...defaults });
}

// Insert-or-update by a unique key.
function upsert(Model, where, attrs = {}) {
  const existing = Model.findBy(where);
  if (existing) {
    existing.update(attrs);
    return existing;
  }
  return Model.create({ ...where, ...attrs });
}

// Run db/seeds.js with a context of models + helpers. `models` is the map the
// application loader built (or {} when called standalone).
async function runSeeds(root, models = {}) {
  const file = path.join(root, 'db', 'seeds.js');
  if (!fs.existsSync(file)) {
    return { ran: false, reason: 'no db/seeds.js' };
  }
  delete require.cache[require.resolve(file)];
  const seedFn = require(file);
  const fn = seedFn.default || seedFn;
  if (typeof fn !== 'function') throw new Error('db/seeds.js must export a function');
  await fn({ models, findOrCreate, upsert });
  return { ran: true };
}

module.exports = { runSeeds, findOrCreate, upsert };
