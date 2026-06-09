'use strict';

const fs = require('fs');
const path = require('path');
const { Schema } = require('./schema');

// Runs pending migrations from <root>/db/migrate. Each migration file is named
// `<version>_<name>.js` (version = numeric timestamp) and exports up()/down():
//
//   module.exports = {
//     up(schema)   { schema.createTable('posts', t => { ... }); },
//     down(schema) { schema.dropTable('posts'); },
//   };
//
// Applied versions are tracked in the schema_migrations table, exactly like AR.

class Migrator {
  constructor(db, migrationsDir) {
    this.db = db;
    this.dir = migrationsDir;
    this._ensureMetaTable();
  }

  _ensureMetaTable() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY);');
  }

  _allFiles() {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.js'))
      .sort()
      .map((f) => ({ version: f.split('_')[0], name: f, file: path.join(this.dir, f) }));
  }

  _applied() {
    return new Set(
      this.db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
    );
  }

  pending() {
    const applied = this._applied();
    return this._allFiles().filter((m) => !applied.has(m.version));
  }

  // Apply every pending migration in order, each in its own transaction.
  migrate() {
    const pending = this.pending();
    const results = [];
    for (const m of pending) {
      const mod = require(m.file);
      const schema = new Schema(this.db);
      const tx = this.db.transaction(() => {
        mod.up(schema);
        this.db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
      });
      tx();
      results.push(m.name);
    }
    return results;
  }

  // Roll back the most recently applied migration.
  rollback() {
    const applied = [...this._applied()].sort();
    const last = applied[applied.length - 1];
    if (!last) return null;
    const m = this._allFiles().find((f) => f.version === last);
    if (!m) throw new Error(`Cannot find migration file for version ${last}`);
    const mod = require(m.file);
    const schema = new Schema(this.db);
    const tx = this.db.transaction(() => {
      if (mod.down) mod.down(schema);
      this.db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(last);
    });
    tx();
    return m.name;
  }

  status() {
    const applied = this._applied();
    return this._allFiles().map((m) => ({ ...m, up: applied.has(m.version) }));
  }
}

module.exports = { Migrator };
