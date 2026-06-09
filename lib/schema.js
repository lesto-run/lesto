'use strict';

// The migration DSL. Inside a migration you get a `schema` object:
//
//   schema.createTable('posts', (t) => {
//     t.string('title');
//     t.text('body');
//     t.integer('views', { default: 0 });
//     t.references('user');      // adds user_id + FK
//     t.timestamps();            // created_at / updated_at
//   });
//
// Every table gets an INTEGER PRIMARY KEY `id` automatically, just like AR.

const TYPES = {
  string: 'TEXT',
  text: 'TEXT',
  integer: 'INTEGER',
  bigint: 'INTEGER',
  float: 'REAL',
  decimal: 'REAL',
  boolean: 'INTEGER',
  datetime: 'TEXT',
  date: 'TEXT',
  json: 'TEXT',
};

class TableDefinition {
  constructor(name) {
    this.name = name;
    this.columns = ['id INTEGER PRIMARY KEY AUTOINCREMENT'];
    this.foreignKeys = [];
  }

  column(name, type, opts = {}) {
    const sqlType = TYPES[type] || 'TEXT';
    let def = `${name} ${sqlType}`;
    if (opts.null === false) def += ' NOT NULL';
    if (opts.unique) def += ' UNIQUE';
    if (opts.default !== undefined) {
      const d = typeof opts.default === 'string' ? `'${opts.default}'` : Number(opts.default);
      def += ` DEFAULT ${d}`;
    }
    this.columns.push(def);
    return this;
  }

  // Adds a `<name>_id` integer column. Like Rails, a real FK CONSTRAINT is only
  // emitted when you opt in with { foreignKey: true } — otherwise the referenced
  // table needn't exist yet (common during incremental scaffolding).
  references(name, opts = {}) {
    const col = `${name}_id`;
    this.column(col, 'integer', { null: opts.null });
    if (opts.foreignKey) {
      const table = opts.table || `${name}s`;
      this.foreignKeys.push(`FOREIGN KEY (${col}) REFERENCES ${table}(id)`);
    }
    return this;
  }

  timestamps() {
    this.column('created_at', 'datetime');
    this.column('updated_at', 'datetime');
    return this;
  }

  toSQL() {
    const parts = [...this.columns, ...this.foreignKeys];
    return `CREATE TABLE ${this.name} (\n  ${parts.join(',\n  ')}\n);`;
  }
}

// Add a typed-column helper for every supported type: t.string(), t.integer()...
for (const type of Object.keys(TYPES)) {
  TableDefinition.prototype[type] = function (name, opts) {
    return this.column(name, type, opts);
  };
}

class Schema {
  constructor(db) {
    this.db = db;
    this.statements = [];
  }

  createTable(name, fn) {
    const t = new TableDefinition(name);
    fn(t);
    this._run(t.toSQL());
  }

  dropTable(name) {
    this._run(`DROP TABLE IF EXISTS ${name};`);
  }

  addColumn(table, name, type, opts = {}) {
    const t = new TableDefinition(table);
    t.column(name, type, opts);
    // last pushed column def (skip the auto id at index 0)
    const colDef = t.columns[t.columns.length - 1];
    this._run(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
  }

  addIndex(table, columns, opts = {}) {
    const cols = Array.isArray(columns) ? columns : [columns];
    const unique = opts.unique ? 'UNIQUE ' : '';
    const name = opts.name || `idx_${table}_${cols.join('_')}`;
    this._run(`CREATE ${unique}INDEX ${name} ON ${table} (${cols.join(', ')});`);
  }

  execute(sql) {
    this._run(sql);
  }

  _run(sql) {
    this.statements.push(sql);
    this.db.exec(sql);
  }
}

module.exports = { Schema, TableDefinition, TYPES };
