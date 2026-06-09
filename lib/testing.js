'use strict';

const database = require('./database');

// First-class testing support. The headline is transactional tests: each test
// runs inside a SAVEPOINT that is rolled back afterward, so tests share one
// migrated database, never persist, and don't need teardown. Fast and isolated.

// Wrap a test body so all its DB writes are rolled back when it finishes
// (whether it passes or throws). Supports async bodies.
async function transaction(fn) {
  const db = database.db();
  db.exec('SAVEPOINT keel_test');
  try {
    return await fn();
  } finally {
    db.exec('ROLLBACK TO keel_test');
    db.exec('RELEASE keel_test');
  }
}

// Returns a wrapped test function that auto-rolls-back. Pair with any runner:
//   const it = transactionalTest(baseIt)
const transactionalTest = (register) => (name, fn) => register(name, () => transaction(fn));

// Connect (and optionally migrate) an isolated test database.
function setupTestDatabase(root, { migrate = true } = {}) {
  database.close();
  const db = database.connect(root, 'test');
  if (migrate) {
    const path = require('path');
    const { Migrator } = require('./migrator');
    new Migrator(db, path.join(root, 'db', 'migrate')).migrate();
  }
  return db;
}

// Empty the given tables (order matters for FKs; caller supplies order).
function clean(tables) {
  const db = database.db();
  for (const t of tables) db.exec(`DELETE FROM ${t}`);
}

module.exports = { transaction, transactionalTest, setupTestDatabase, clean };
