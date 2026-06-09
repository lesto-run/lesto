import { database } from "./connection";
import { OrmError } from "./errors";
import { quoteColumn, quoteIdentifier } from "./identifier";
import { tableize } from "./inflector";
import { Relation } from "./relation";
import { validate, ValidationErrors } from "./validations";

import type { QuerySource } from "./relation";
import type { Attributes, SortDirection, WhereConditions } from "./types";
import type { ValidationRules } from "./validations";

// re-export so a single `import { ValidationRules } from "@keel/orm"` works
export type { ValidationRule, ValidationRules } from "./validations";

/**
 * ActiveRecord, in TypeScript.
 *
 * Subclass it and you inherit querying, persistence, and validation by
 * convention: `class Post extends Model {}` maps to table `posts`, queries
 * return `Post` instances, and `static validations` gate every save.
 *
 * Persistence writes exactly the attributes you set — no schema introspection —
 * so the model is driver-agnostic. Opt into `created_at` / `updated_at` upkeep
 * with `static timestamps = true`.
 */

function normalize(value: unknown): unknown {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (value === undefined) {
    return null;
  }

  if (value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }

  return value;
}

export class Model {
  static tableName: string | undefined;

  static primaryKey = "id";

  static validations: ValidationRules = {};

  static timestamps = false;

  /**
   * The model's columns, used as the allowlist for any identifier that reaches
   * SQL (where/order/pluck keys). Leave it `undefined` to opt out of allowlist
   * enforcement and rely on identifier quoting alone — declare it to slam the
   * door on unknown columns entirely.
   */
  static columns: readonly string[] | undefined = undefined;

  /** The table this model reads and writes. Inferred from the class name. */
  static table(this: typeof Model): string {
    return this.tableName ?? tableize(this.name);
  }

  /**
   * The allowlist of identifiers this model accepts, or `undefined` when none
   * is declared. The primary key and (when enabled) the timestamp columns are
   * always included, since the ORM references them itself.
   */
  static knownColumns(this: typeof Model): readonly string[] | undefined {
    if (this.columns === undefined) {
      return undefined;
    }

    const implicit = this.timestamps
      ? [this.primaryKey, "created_at", "updated_at"]
      : [this.primaryKey];

    return [...new Set([...this.columns, ...implicit])];
  }

  static instantiate(this: typeof Model, row: Attributes): Model {
    const record = new this();
    Object.assign(record.attributes, row);
    record.persisted = true;

    return record;
  }

  private static source(this: typeof Model): QuerySource<Model> {
    return {
      table: this.table(),
      primaryKey: this.primaryKey,
      columns: this.knownColumns(),
      database: () => database(),
      instantiate: (row) => this.instantiate(row),
    };
  }

  static all<T extends typeof Model>(this: T): Relation<InstanceType<T>> {
    return new Relation(this.source() as QuerySource<InstanceType<T>>);
  }

  static where<T extends typeof Model>(
    this: T,
    conditions: WhereConditions,
  ): Relation<InstanceType<T>> {
    return this.all().where(conditions);
  }

  static order<T extends typeof Model>(
    this: T,
    column: string,
    direction?: SortDirection,
  ): Relation<InstanceType<T>> {
    return this.all().order(column, direction);
  }

  static limit<T extends typeof Model>(this: T, count: number): Relation<InstanceType<T>> {
    return this.all().limit(count);
  }

  static count(this: typeof Model): number {
    return this.all().count();
  }

  static find<T extends typeof Model>(this: T, id: unknown): InstanceType<T> {
    const record = this.all()
      .where({ [this.primaryKey]: id })
      .first();

    if (!record) {
      throw new OrmError(
        "ORM_RECORD_NOT_FOUND",
        `Couldn't find ${this.name} with ${this.primaryKey}=${String(id)}.`,
        {
          model: this.name,
          id,
        },
      );
    }

    return record;
  }

  static findBy<T extends typeof Model>(
    this: T,
    conditions: WhereConditions,
  ): InstanceType<T> | undefined {
    return this.all().where(conditions).first();
  }

  static create<T extends typeof Model>(this: T, attributes: Attributes = {}): InstanceType<T> {
    const record = new this(attributes) as InstanceType<T>;
    record.save();

    return record;
  }

  // ---- instance ----

  readonly attributes: Attributes = {};

  errors: ValidationErrors = new ValidationErrors();

  private persisted = false;

  constructor(attributes: Attributes = {}) {
    Object.assign(this.attributes, attributes);
  }

  private get model(): typeof Model {
    return this.constructor as typeof Model;
  }

  get id(): unknown {
    return this.attributes[this.model.primaryKey];
  }

  get isPersisted(): boolean {
    return this.persisted;
  }

  get isNew(): boolean {
    return !this.persisted;
  }

  get(key: string): unknown {
    return this.attributes[key];
  }

  set(key: string, value: unknown): this {
    this.attributes[key] = value;

    return this;
  }

  assign(attributes: Attributes): this {
    Object.assign(this.attributes, attributes);

    return this;
  }

  isValid(): boolean {
    this.errors = validate(this.model.validations, this.attributes);

    return this.errors.isEmpty;
  }

  save(): boolean {
    if (!this.isValid()) {
      return false;
    }

    if (this.persisted) {
      this.persist("update");
    } else {
      this.persist("insert");
    }

    return true;
  }

  update(attributes: Attributes): boolean {
    return this.assign(attributes).save();
  }

  destroy(): this {
    const table = quoteIdentifier(this.model.table());
    const pk = quoteIdentifier(this.model.primaryKey);

    database().prepare(`DELETE FROM ${table} WHERE ${pk} = ?`).run([this.id]);
    this.persisted = false;

    return this;
  }

  reload(): this {
    const fresh = this.model.find(this.id);
    Object.assign(this.attributes, fresh.attributes);

    return this;
  }

  toJSON(): Attributes {
    return { ...this.attributes };
  }

  // ---- persistence ----

  private writableColumns(): string[] {
    return Object.keys(this.attributes).filter((column) => column !== this.model.primaryKey);
  }

  // True when the caller set the primary key themselves (e.g. a UUID or a
  // natural key) — we must write it rather than let the database assign one.
  private hasExplicitPrimaryKey(): boolean {
    const pk = this.attributes[this.model.primaryKey];

    return pk !== undefined && pk !== null;
  }

  private touchTimestamps(forInsert: boolean): void {
    if (!this.model.timestamps) {
      return;
    }

    const now = new Date().toISOString();

    if (forInsert) {
      this.attributes["created_at"] = now;
    }

    this.attributes["updated_at"] = now;
  }

  private persist(mode: "insert" | "update"): void {
    this.touchTimestamps(mode === "insert");

    const allowed = this.model.knownColumns();
    const table = quoteIdentifier(this.model.table());

    if (mode === "insert") {
      // Honor an explicitly-provided primary key (UUIDs, natural keys); only
      // fall back to a database-assigned id when the caller left it blank.
      const explicitPk = this.hasExplicitPrimaryKey();
      const columns = explicitPk
        ? [this.model.primaryKey, ...this.writableColumns()]
        : this.writableColumns();
      const values = columns.map((column) => normalize(this.attributes[column]));
      const names = columns.map((column) => quoteColumn(column, allowed)).join(", ");
      const placeholders = columns.map(() => "?").join(", ");

      const result = database()
        .prepare(`INSERT INTO ${table} (${names}) VALUES (${placeholders})`)
        .run(values);

      if (!explicitPk) {
        this.attributes[this.model.primaryKey] = Number(result.lastInsertRowid);
      }

      this.persisted = true;

      return;
    }

    const columns = this.writableColumns();
    const values = columns.map((column) => normalize(this.attributes[column]));
    const pk = quoteColumn(this.model.primaryKey, allowed);
    const assignments = columns.map((column) => `${quoteColumn(column, allowed)} = ?`).join(", ");

    database()
      .prepare(`UPDATE ${table} SET ${assignments} WHERE ${pk} = ?`)
      .run([...values, this.id]);
  }
}
