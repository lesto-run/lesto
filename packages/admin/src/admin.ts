import { AdminError } from "./errors";

import type { Model } from "@keel/orm";

/**
 * A resource is one model exposed to the admin, plus the attributes the UI may
 * read and write. `fields` is the allow-list: the projection never leaks a
 * column the operator didn't declare.
 */
export interface AdminResource {
  name: string;
  model: typeof Model;
  fields: string[];
}

/** What `resources()` and `describe()` hand back — the model stays server-side. */
interface ResourceSummary {
  name: string;
  fields: string[];
}

type Record_ = Record<string, unknown>;

/**
 * The admin operations layer over `@keel/orm`.
 *
 * It resolves a resource name to its model and projects every record down to
 * `{ id, ...declared fields }` — the generic CRUD backbone a WordPress-style
 * admin UI sits on. CRUD goes through the ORM; this layer owns naming,
 * projection, and the not-found / unknown-resource codes.
 */
export class Admin {
  private readonly byName: Map<string, AdminResource>;

  constructor(resources: AdminResource[]) {
    this.byName = new Map(resources.map((resource) => [resource.name, resource]));
  }

  /** Every resource, summarized — name and exposed fields, no model. */
  resources(): ResourceSummary[] {
    return [...this.byName.values()].map((resource) => summarize(resource));
  }

  /** One resource, summarized. Throws if the name is unknown. */
  describe(name: string): ResourceSummary {
    return summarize(this.resolve(name));
  }

  /** Every record, projected to `{ id, ...declared fields }`. */
  list(name: string): Record_[] {
    const resource = this.resolve(name);

    return resource.model
      .all()
      .all()
      .map((record) => project(resource, record));
  }

  /** One record by id, projected. Throws if absent. */
  get(name: string, id: unknown): Record_ {
    const resource = this.resolve(name);

    return project(resource, this.fetch(resource, id));
  }

  /** Persist a new record, then return its projection. */
  create(name: string, attributes: Record_): Record_ {
    const resource = this.resolve(name);

    return project(resource, resource.model.create(attributes));
  }

  /** Update an existing record, then return its projection. Throws if absent. */
  update(name: string, id: unknown, attributes: Record_): Record_ {
    const resource = this.resolve(name);
    const record = this.fetch(resource, id);

    record.update(attributes);

    return project(resource, record);
  }

  /** Delete an existing record. Throws if absent. */
  destroy(name: string, id: unknown): void {
    const resource = this.resolve(name);

    this.fetch(resource, id).destroy();
  }

  // ---- internals ----

  /** Resolve a name to its resource, or refuse with a coded error. */
  private resolve(name: string): AdminResource {
    const resource = this.byName.get(name);

    if (!resource) {
      throw new AdminError("ADMIN_UNKNOWN_RESOURCE", `No admin resource named "${name}".`, {
        name,
      });
    }

    return resource;
  }

  /** Load one record by id, or refuse with a coded error. */
  private fetch(resource: AdminResource, id: unknown): Model {
    const record = resource.model.findBy({ [resource.model.primaryKey]: id });

    if (!record) {
      throw new AdminError(
        "ADMIN_RECORD_NOT_FOUND",
        `No ${resource.name} record with ${resource.model.primaryKey}=${String(id)}.`,
        { name: resource.name, id },
      );
    }

    return record;
  }
}

/** A resource without its model — safe to hand to a client. */
function summarize(resource: AdminResource): ResourceSummary {
  return { name: resource.name, fields: [...resource.fields] };
}

/** Project a record down to `{ id, ...declared fields }` — the allow-list in action. */
function project(resource: AdminResource, record: Model): Record_ {
  const projected: Record_ = { id: record.id };

  for (const field of resource.fields) {
    projected[field] = record.get(field);
  }

  return projected;
}
