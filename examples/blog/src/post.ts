/**
 * The Post model — ActiveRecord by convention.
 *
 * The class name `Post` maps to the table `posts`; every query returns `Post`
 * instances. `timestamps = true` opts into automatic `created_at` / `updated_at`
 * upkeep, and the validations gate every save so an empty title never persists.
 */

import { Model } from "@keel/orm";
import type { ValidationRules } from "@keel/orm";

export class Post extends Model {
  static override timestamps = true;

  static override validations: ValidationRules = {
    title: { presence: true },
  };
}
