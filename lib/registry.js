'use strict';

// Global model registry so associations can resolve siblings by class name
// ("Comment" -> the Comment class) without import cycles.
const models = new Map();

module.exports = {
  register(name, klass) {
    models.set(name, klass);
  },
  lookup(name) {
    return models.get(name);
  },
  all() {
    return [...models.values()];
  },
};
