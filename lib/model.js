'use strict';

const database = require('./database');
const registry = require('./registry');
const { Relation } = require('./relation');
const { validate } = require('./validations');
const { tableize, underscore, singularize, pluralize } = require('./inflector');

// The ActiveRecord-style base class. Subclass it, and you inherit a full
// querying / persistence / validation / association toolkit by convention:
//
//   class Post extends Model {
//     static validations = { title: { presence: true } };
//     static associations = {
//       comments: { hasMany: 'Comment' },
//       author:   { belongsTo: 'User' },
//     };
//   }
//
//   Post.create({ title: 'Hi' });
//   Post.where({ published: true }).order('created_at', 'desc').all();
//   post.comments().all();
//
class Model {
  // ---- configuration (overridable per subclass) ----
  static get tableName() {
    return this._tableName || tableize(this.name);
  }
  static set tableName(v) {
    this._tableName = v;
  }
  static get primaryKey() {
    return 'id';
  }

  // Cached column metadata from PRAGMA table_info.
  static get columns() {
    if (!this._columns || this._columnsTable !== this.tableName) {
      this._columns = this._db().prepare(`PRAGMA table_info(${this.tableName})`).all().map((c) => c.name);
      this._columnsTable = this.tableName;
    }
    return this._columns;
  }

  static _db() {
    return database.db();
  }

  static _instantiate(row) {
    const inst = new this();
    Object.assign(inst.attributes, row);
    inst._persisted = true;
    return inst;
  }

  // ---- class-level query interface ----
  static all() {
    return new Relation(this).all();
  }
  static where(...args) {
    return new Relation(this).where(...args);
  }
  static order(...args) {
    return new Relation(this).order(...args);
  }
  static limit(n) {
    return new Relation(this).limit(n);
  }
  static first() {
    return new Relation(this).first();
  }
  static last() {
    return new Relation(this).last();
  }
  static count() {
    return new Relation(this).count();
  }

  static find(id) {
    const row = this._db()
      .prepare(`SELECT * FROM ${this.tableName} WHERE ${this.primaryKey} = ?`)
      .get(id);
    if (!row) throw new RecordNotFound(`Couldn't find ${this.name} with ${this.primaryKey}=${id}`);
    return this._instantiate(row);
  }

  static findBy(conditions) {
    return new Relation(this).where(conditions).first();
  }

  static create(attrs = {}) {
    const inst = new this(attrs);
    inst.save();
    return inst;
  }

  // ---- instance ----
  constructor(attrs = {}) {
    this.attributes = {};
    this._persisted = false;
    this.errors = null;
    Object.assign(this.attributes, attrs);
    return defineAttributeProxy(this);
  }

  get isPersisted() {
    return this._persisted;
  }
  get isNew() {
    return !this._persisted;
  }
  get id() {
    return this.attributes[this.constructor.primaryKey];
  }

  // Run validations; populate this.errors; return boolean.
  isValid() {
    this._runCallback('beforeValidation');
    this.errors = validate(this);
    return this.errors.isEmpty;
  }

  save() {
    if (!this.isValid()) return false;
    this._runCallback('beforeSave');
    if (this._persisted) {
      this._runCallback('beforeUpdate');
      this._update();
      this._runCallback('afterUpdate');
    } else {
      this._runCallback('beforeCreate');
      this._insert();
      this._runCallback('afterCreate');
    }
    this._runCallback('afterSave');
    return true;
  }

  // Assign + save in one call.
  update(attrs) {
    Object.assign(this.attributes, attrs);
    return this.save();
  }

  destroy() {
    this._runCallback('beforeDestroy');
    this.constructor
      ._db()
      .prepare(`DELETE FROM ${this.constructor.tableName} WHERE ${this.constructor.primaryKey} = ?`)
      .run(this.id);
    this._persisted = false;
    this._runCallback('afterDestroy');
    return this;
  }

  reload() {
    const fresh = this.constructor.find(this.id);
    this.attributes = fresh.attributes;
    return this;
  }

  toJSON() {
    return { ...this.attributes };
  }

  // ---- persistence internals ----
  _writableColumns() {
    const cols = this.constructor.columns;
    return cols.filter((c) => c !== this.constructor.primaryKey && c in this.attributes);
  }

  _touchTimestamps(forInsert) {
    const cols = this.constructor.columns;
    const now = new Date().toISOString();
    if (forInsert && cols.includes('created_at') && this.attributes.created_at == null) {
      this.attributes.created_at = now;
    }
    if (cols.includes('updated_at')) this.attributes.updated_at = now;
  }

  _insert() {
    this._touchTimestamps(true);
    const cols = this._writableColumns();
    const placeholders = cols.map(() => '?').join(', ');
    const values = cols.map((c) => normalize(this.attributes[c]));
    const sql = `INSERT INTO ${this.constructor.tableName} (${cols.join(', ')}) VALUES (${placeholders})`;
    const info = this.constructor._db().prepare(sql).run(...values);
    this.attributes[this.constructor.primaryKey] = Number(info.lastInsertRowid);
    this._persisted = true;
  }

  _update() {
    this._touchTimestamps(false);
    const cols = this._writableColumns();
    const assignments = cols.map((c) => `${c} = ?`).join(', ');
    const values = cols.map((c) => normalize(this.attributes[c]));
    const sql = `UPDATE ${this.constructor.tableName} SET ${assignments} WHERE ${this.constructor.primaryKey} = ?`;
    this.constructor._db().prepare(sql).run(...values, this.id);
  }

  // ---- callbacks ----
  // Define hooks as instance methods on the subclass: beforeSave(), afterCreate()...
  _runCallback(name) {
    if (typeof this[name] === 'function') this[name]();
  }

  // ---- associations ----
  _association(name) {
    const defs = this.constructor.associations || {};
    const def = defs[name];
    if (!def) return undefined;

    if (def.belongsTo) {
      const Target = registry.lookup(def.belongsTo);
      const fk = def.foreignKey || `${underscore(def.belongsTo)}_id`;
      const val = this.attributes[fk];
      return () => (val == null ? null : Target.findBy({ [Target.primaryKey]: val }));
    }
    if (def.hasMany) {
      const Target = registry.lookup(def.hasMany);
      const fk = def.foreignKey || `${underscore(this.constructor.name)}_id`;
      return () => Target.where({ [fk]: this.id });
    }
    if (def.hasOne) {
      const Target = registry.lookup(def.hasOne);
      const fk = def.foreignKey || `${underscore(this.constructor.name)}_id`;
      return () => Target.where({ [fk]: this.id }).first();
    }
    return undefined;
  }
}

class RecordNotFound extends Error {}
Model.RecordNotFound = RecordNotFound;

// SQLite has no native boolean; store as 0/1. Dates already ISO strings.
function normalize(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

// Make column values and associations readable/writable directly on the
// instance (post.title, post.comments()) while keeping the canonical store in
// this.attributes.
function defineAttributeProxy(instance) {
  return new Proxy(instance, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !(prop in target) && !prop.startsWith('_')) {
        const assoc = target._association(prop);
        if (assoc) return assoc;
        if (prop in target.attributes) return target.attributes[prop];
      }
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      if (
        typeof prop === 'string' &&
        !prop.startsWith('_') &&
        !(prop in target) &&
        target.constructor.columns.includes(prop)
      ) {
        target.attributes[prop] = value;
        return true;
      }
      return Reflect.set(target, prop, value, receiver);
    },
  });
}

module.exports = { Model, RecordNotFound };
