'use strict';

// A lazy, chainable query builder — the JS answer to ActiveRecord::Relation.
//
//   Post.where({ published: true }).order('created_at', 'desc').limit(5).all()
//
// Nothing touches the database until a terminal method (all/first/count/each…)
// is called, so chains compose freely.
class Relation {
  constructor(model) {
    this.model = model;
    this._wheres = [];   // { sql, params }
    this._order = [];
    this._limit = null;
    this._offset = null;
  }

  _clone() {
    const r = new Relation(this.model);
    r._wheres = [...this._wheres];
    r._order = [...this._order];
    r._limit = this._limit;
    r._offset = this._offset;
    return r;
  }

  // where({ a: 1, b: [2,3] })  or  where('views > ?', 10)
  where(conditions, ...params) {
    const r = this._clone();
    if (typeof conditions === 'string') {
      r._wheres.push({ sql: conditions, params: params.map(bindable) });
    } else {
      for (const [key, val] of Object.entries(conditions)) {
        if (val === null) {
          r._wheres.push({ sql: `${key} IS NULL`, params: [] });
        } else if (Array.isArray(val)) {
          const placeholders = val.map(() => '?').join(', ');
          r._wheres.push({ sql: `${key} IN (${placeholders})`, params: val.map(bindable) });
        } else {
          r._wheres.push({ sql: `${key} = ?`, params: [bindable(val)] });
        }
      }
    }
    return r;
  }

  order(column, dir = 'asc') {
    const r = this._clone();
    r._order.push(`${column} ${String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`);
    return r;
  }

  limit(n) {
    const r = this._clone();
    r._limit = n;
    return r;
  }

  offset(n) {
    const r = this._clone();
    r._offset = n;
    return r;
  }

  _build(select = '*') {
    const params = [];
    let sql = `SELECT ${select} FROM ${this.model.tableName}`;
    if (this._wheres.length) {
      sql += ' WHERE ' + this._wheres.map((w) => w.sql).join(' AND ');
      for (const w of this._wheres) params.push(...w.params);
    }
    if (this._order.length) sql += ' ORDER BY ' + this._order.join(', ');
    if (this._limit != null) sql += ` LIMIT ${Number(this._limit)}`;
    if (this._offset != null) sql += ` OFFSET ${Number(this._offset)}`;
    return { sql, params };
  }

  // --- terminal methods ---

  all() {
    const { sql, params } = this._build();
    return this.model._db().prepare(sql).all(...params).map((row) => this.model._instantiate(row));
  }

  toArray() {
    return this.all();
  }

  first() {
    const r = this._order.length ? this : this.order(this.model.primaryKey, 'asc');
    const { sql, params } = r.limit(1)._build();
    const row = this.model._db().prepare(sql).get(...params);
    return row ? this.model._instantiate(row) : null;
  }

  last() {
    const { sql, params } = this.order(this.model.primaryKey, 'desc').limit(1)._build();
    const row = this.model._db().prepare(sql).get(...params);
    return row ? this.model._instantiate(row) : null;
  }

  count() {
    const { sql, params } = this._build('COUNT(*) AS n');
    return this.model._db().prepare(sql).get(...params).n;
  }

  exists() {
    return this.limit(1).count() > 0;
  }

  pluck(column) {
    const { sql, params } = this._build(column);
    return this.model._db().prepare(sql).all(...params).map((r) => r[column]);
  }

  each(fn) {
    this.all().forEach(fn);
  }

  map(fn) {
    return this.all().map(fn);
  }

  // Iterable: for (const post of Post.where(...)) { ... }
  [Symbol.iterator]() {
    return this.all()[Symbol.iterator]();
  }
}

// SQLite only binds numbers, strings, bigints, buffers, and null — coerce the
// JS types the ORM stores (booleans -> 0/1) so query params match column values.
function bindable(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

module.exports = { Relation };
