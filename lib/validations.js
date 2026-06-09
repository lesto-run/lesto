'use strict';

const { humanize } = require('./inflector');

// Runs a model instance's static `validations` map and collects errors.
//
//   static validations = {
//     title: { presence: true, length: { min: 3, max: 120 } },
//     email: { presence: true, format: /@/, uniqueness: true },
//     age:   { numericality: true },
//   };
//
// Returns an Errors object: { isEmpty(), add(), full(), on(field) }.

class Errors {
  constructor() {
    this.map = {};
  }
  add(field, message) {
    (this.map[field] ||= []).push(message);
  }
  on(field) {
    return this.map[field] || [];
  }
  get isEmpty() {
    return Object.keys(this.map).length === 0;
  }
  get count() {
    return Object.values(this.map).reduce((n, a) => n + a.length, 0);
  }
  // Human-readable messages: ["Title can't be blank", ...]
  full() {
    const out = [];
    for (const [field, msgs] of Object.entries(this.map)) {
      for (const m of msgs) out.push(`${humanize(field)} ${m}`);
    }
    return out;
  }
}

function validate(instance) {
  const errors = new Errors();
  const rules = instance.constructor.validations || {};

  for (const [field, ruleset] of Object.entries(rules)) {
    const value = instance[field];

    if (ruleset.presence) {
      if (value == null || String(value).trim() === '') {
        errors.add(field, "can't be blank");
        continue; // other checks are moot if blank
      }
    }

    if (value == null || value === '') continue; // remaining rules skip blanks

    if (ruleset.length) {
      const len = String(value).length;
      const { min, max, is } = ruleset.length;
      if (min != null && len < min) errors.add(field, `is too short (minimum is ${min} characters)`);
      if (max != null && len > max) errors.add(field, `is too long (maximum is ${max} characters)`);
      if (is != null && len !== is) errors.add(field, `is the wrong length (should be ${is} characters)`);
    }

    if (ruleset.format && !ruleset.format.test(String(value))) {
      errors.add(field, 'is invalid');
    }

    if (ruleset.numericality && Number.isNaN(Number(value))) {
      errors.add(field, 'is not a number');
    }

    if (ruleset.inclusion && !ruleset.inclusion.includes(value)) {
      errors.add(field, 'is not included in the list');
    }

    if (ruleset.uniqueness) {
      const rel = instance.constructor.where({ [field]: value });
      const dup = rel.all().find((r) => r[instance.constructor.primaryKey] !== instance[instance.constructor.primaryKey]);
      if (dup) errors.add(field, 'has already been taken');
    }
  }

  return errors;
}

module.exports = { validate, Errors };
