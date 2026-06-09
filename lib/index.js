'use strict';

// Public API surface for the Tracks framework.
//
//   const { Model, Controller } = require('tracks');

const { Model, RecordNotFound } = require('./model');
const { Controller } = require('./controller');
const { Application } = require('./application');
const { Migrator } = require('./migrator');
const { Schema } = require('./schema');
const { draw, Router } = require('./router');
const inflector = require('./inflector');
const database = require('./database');
const registry = require('./registry');
const queue = require('./queue');
const seeds = require('./seeds');
const testing = require('./testing');
const masking = require('./masking');

module.exports = {
  Model,
  RecordNotFound,
  Controller,
  Application,
  Migrator,
  Schema,
  Router,
  draw,
  inflector,
  database,
  registry,
  // jobs / scheduling
  Queue: queue.Queue,
  Scheduler: queue.Scheduler,
  queue,
  // DB lifecycle
  seeds,
  testing,
  masking,
  version: require('../package.json').version,
};
