'use strict';

const fs = require('fs');
const path = require('path');
const database = require('./database');
const registry = require('./registry');
const { draw } = require('./router');
const { ViewRenderer } = require('./view');
const { buildHelpers } = require('./helpers');
const { Server } = require('./server');

// Boots a Tracks app from an app directory following the conventional layout:
//
//   app/
//     models/        Post.js        -> class Post extends Model
//     controllers/   PostsController.js
//     views/         posts/index.html.ejs, layouts/application.html.ejs
//   config/
//     routes.js      module.exports = (r) => { r.resources('posts'); }
//   db/
//     migrate/       0001_create_posts.js
//
class Application {
  constructor(root, env = process.env.TRACKS_ENV || 'development') {
    this.root = root;
    this.env = env;
    this.models = {};
    this.controllers = {};
    this.router = null;
    this.views = null;
  }

  boot() {
    database.connect(this.root, this.env);
    this._loadModels();
    this._loadRoutes();
    this._loadControllers();
    this._setupViews();
    return this;
  }

  _appDir(...p) {
    return path.join(this.root, 'app', ...p);
  }

  _requireAll(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => {
        delete require.cache[require.resolve(path.join(dir, f))];
        return { name: f.replace(/\.js$/, ''), mod: require(path.join(dir, f)) };
      });
  }

  _loadModels() {
    for (const { name, mod } of this._requireAll(this._appDir('models'))) {
      const klass = mod.default || mod[name] || mod;
      this.models[name] = klass;
      registry.register(name, klass);
    }
  }

  _loadControllers() {
    for (const { name, mod } of this._requireAll(this._appDir('controllers'))) {
      const klass = mod.default || mod[name] || mod;
      // Router stores controllers by underscored resource name (e.g. "posts").
      const key = require('./inflector').underscore(name.replace(/Controller$/, ''));
      this.controllers[key] = klass;
    }
  }

  _loadRoutes() {
    const file = path.join(this.root, 'config', 'routes.js');
    if (!fs.existsSync(file)) {
      this.router = draw(() => {});
      return;
    }
    delete require.cache[require.resolve(file)];
    const drawFn = require(file);
    this.router = draw(drawFn);
  }

  _setupViews() {
    const helpers = buildHelpers(this.router);
    this.views = new ViewRenderer(this._appDir('views'), helpers);
  }

  server() {
    return new Server(this);
  }

  start(port = 3000, host = '127.0.0.1') {
    const server = this.server();
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve(server));
    });
  }
}

module.exports = { Application };
