#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const repl = require('repl');

const generators = require('../lib/generators');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[90m',
  green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m',
};
const color = (c, s) => `${C[c]}${s}${C.reset}`;

function printGenLog(entries) {
  const tint = { create: 'green', force: 'yellow', exist: 'dim', route: 'cyan' };
  for (const [action, file] of entries) {
    console.log(`      ${color(tint[action] || 'reset', action.padStart(6))}  ${file}`);
  }
}

// Find the app root by walking up for config/routes.js (fallback: cwd).
function findRoot(start = process.cwd()) {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'config', 'routes.js'))) return dir;
    dir = path.dirname(dir);
  }
  return start;
}

// Next migration version seed = number of existing migrations + 1.
function nextSeed(root) {
  const dir = path.join(root, 'db', 'migrate');
  if (!fs.existsSync(dir)) return 1;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).length + 1;
}

function bootApp(root) {
  // Make `require('tracks')` resolve to this framework from inside the app.
  const Module = require('module');
  const frameworkRoot = path.join(__dirname, '..');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'tracks' || request.startsWith('tracks/')) {
      const sub = request === 'tracks' ? 'lib/index.js' : request.slice('tracks/'.length);
      return origResolve.call(this, path.join(frameworkRoot, sub), ...rest);
    }
    return origResolve.call(this, request, ...rest);
  };
  const { Application } = require('../lib/index');
  return new Application(root).boot();
}

const commands = {
  new(args) {
    const name = args[0];
    if (!name) return fail('Usage: tracks new <AppName>');
    const root = path.resolve(process.cwd(), name);
    if (fs.existsSync(root) && fs.readdirSync(root).length) return fail(`Directory ${name} already exists and is not empty.`);
    console.log(`\n  Creating a new Tracks app in ${color('cyan', root)}\n`);
    printGenLog(generators.newApp(root, name));
    console.log(`\n  ${color('green', 'Done!')} Next:\n`);
    console.log(color('dim', `    cd ${name}`));
    console.log(color('dim', '    npm install'));
    console.log(color('dim', '    tracks generate scaffold Post title:string body:text'));
    console.log(color('dim', '    tracks db:migrate'));
    console.log(color('dim', '    tracks server\n'));
  },

  generate(args) {
    const [kind, name, ...fields] = args;
    const root = findRoot();
    const seed = nextSeed(root);
    if (!name) return fail(`Usage: tracks generate <model|controller|scaffold> NAME [field:type ...]`);
    console.log();
    switch (kind) {
      case 'model':
        printGenLog(generators.generateModel(root, name, fields, { seed }));
        break;
      case 'controller':
        printGenLog(generators.generateController(root, name, fields));
        break;
      case 'scaffold':
        printGenLog(generators.generateScaffold(root, name, fields, { seed }));
        break;
      default:
        return fail(`Unknown generator: ${kind}`);
    }
    console.log(color('dim', `\n  Run \`tracks db:migrate\` to apply new migrations.\n`));
  },

  'db:migrate'() {
    const root = findRoot();
    const { database, Migrator } = require('../lib/index');
    const db = database.connect(root);
    const m = new Migrator(db, path.join(root, 'db', 'migrate'));
    const applied = m.migrate();
    if (!applied.length) console.log(color('dim', '  Nothing to migrate. Schema is up to date.'));
    for (const name of applied) console.log(`  ${color('green', 'migrated')}  ${name}`);
  },

  'db:rollback'() {
    const root = findRoot();
    const { database, Migrator } = require('../lib/index');
    const db = database.connect(root);
    const m = new Migrator(db, path.join(root, 'db', 'migrate'));
    const rolled = m.rollback();
    console.log(rolled ? `  ${color('yellow', 'rolled back')}  ${rolled}` : color('dim', '  Nothing to roll back.'));
  },

  'db:status'() {
    const root = findRoot();
    const { database, Migrator } = require('../lib/index');
    const db = database.connect(root);
    const m = new Migrator(db, path.join(root, 'db', 'migrate'));
    console.log();
    for (const s of m.status()) {
      const badge = s.up ? color('green', '  up  ') : color('red', ' down ');
      console.log(`  ${badge}  ${s.version}  ${s.name}`);
    }
    console.log();
  },

  // Seed the database from db/seeds.js (idempotent).
  async 'db:seed'() {
    const root = findRoot();
    const app = bootApp(root);
    const { seeds } = require('../lib/index');
    const res = await seeds.runSeeds(root, app.models);
    console.log(res.ran ? `  ${color('green', 'seeded')}  db/seeds.js` : color('dim', `  ${res.reason}`));
  },

  // Drop the database, re-run all migrations, and re-seed — a clean local slate.
  async 'db:reset'() {
    const root = findRoot();
    const { database, Migrator, seeds } = require('../lib/index');
    const env = process.env.TRACKS_ENV || 'development';
    database.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = path.join(root, 'db', `${env}.sqlite3${suffix}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    const db = database.connect(root, env);
    const applied = new Migrator(db, path.join(root, 'db', 'migrate')).migrate();
    console.log(`  ${color('yellow', 'reset')}  dropped + migrated ${applied.length} migration(s)`);
    const app = bootApp(root);
    const res = await seeds.runSeeds(root, app.models);
    if (res.ran) console.log(`  ${color('green', 'seeded')}  db/seeds.js`);
  },

  // Mask PII in the local database using db/masking.js config (for prod pulls).
  'db:mask'() {
    const root = findRoot();
    const { database, masking } = require('../lib/index');
    const file = path.join(root, 'db', 'masking.js');
    if (!fs.existsSync(file)) return fail('No db/masking.js config found.');
    const config = require(file);
    database.connect(root);
    const counts = masking.maskDatabase(config.default || config);
    for (const [table, n] of Object.entries(counts)) console.log(`  ${color('green', 'masked')}  ${table}  ${color('dim', `(${n} rows)`)}`);
  },

  // Install the jobs table.
  'queue:install'() {
    const root = findRoot();
    const { database, queue } = require('../lib/index');
    queue.installSchema(database.connect(root));
    console.log(`  ${color('green', 'installed')}  keel_jobs table`);
  },

  // Run a worker: load app/jobs/*.js (each registers handlers), drain the queue.
  async 'queue:work'(args) {
    const root = findRoot();
    const { database, queue } = require('../lib/index');
    const db = database.connect(root);
    queue.installSchema(db);
    const jobsDir = path.join(root, 'app', 'jobs');
    if (fs.existsSync(jobsDir)) {
      for (const f of fs.readdirSync(jobsDir).filter((x) => x.endsWith('.js'))) require(path.join(jobsDir, f));
    }
    const concurrency = Number(getFlag(args, '--concurrency', '-c') || 1);
    console.log(`\n  ${color('magenta', '⚙  Keel worker')}  ${color('dim', `concurrency=${concurrency}`)}`);
    const worker = queue.work({ concurrency });
    const shutdown = async () => { console.log(color('dim', '\n  draining…')); await worker.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  },

  routes() {
    const app = bootApp(findRoot());
    const rows = app.router.list();
    const wName = Math.max(6, ...rows.map((r) => (r.name || '').length));
    const wPat = Math.max(7, ...rows.map((r) => r.pattern.length));
    console.log();
    console.log(`  ${'Name'.padEnd(wName)}  ${'Verb'.padEnd(6)}  ${'Pattern'.padEnd(wPat)}  Controller#Action`);
    console.log(`  ${color('dim', '-'.repeat(wName + wPat + 30))}`);
    for (const r of rows) {
      console.log(
        `  ${color('cyan', (r.name || '').padEnd(wName))}  ${color('yellow', r.method.padEnd(6))}  ${r.pattern.padEnd(wPat)}  ${color('dim', r.to)}`
      );
    }
    console.log();
    require('../lib/index').database.close();
  },

  async server(args) {
    const port = Number(getFlag(args, '--port', '-p') || process.env.PORT || 3000);
    const host = getFlag(args, '--host') || '127.0.0.1';
    const root = findRoot();
    const app = bootApp(root);
    await app.start(port, host);
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    console.log(`\n  ${color('magenta', '🛤  Tracks')} ${color('dim', 'v' + require('../package.json').version)}  ${color('dim', '(' + app.env + ')')}`);
    console.log(`  ${color('green', '→')} listening on ${color('cyan', url)}`);
    console.log(color('dim', '  Ctrl-C to stop\n'));
  },

  console() {
    const root = findRoot();
    const app = bootApp(root);
    console.log(color('magenta', `\n  Tracks console ${color('dim', '(' + app.env + ')')}`));
    console.log(color('dim', `  Models loaded: ${Object.keys(app.models).join(', ') || '(none)'}\n`));
    const r = repl.start({ prompt: 'tracks> ' });
    Object.assign(r.context, app.models, { app, db: require('../lib/index').database.db() });
  },

  version() {
    console.log('Tracks v' + require('../package.json').version);
  },

  help() {
    console.log(`
  ${color('magenta', '🛤  Tracks')} — Rails, but it's JavaScript.

  ${color('bold', 'Usage:')} tracks <command> [options]

  ${color('bold', 'Commands:')}
    ${color('cyan', 'new')} <name>                 Create a new application
    ${color('cyan', 'generate')} model NAME f:t     Generate a model + migration   ${color('dim', '(alias: g)')}
    ${color('cyan', 'generate')} controller NAME a  Generate a controller + views
    ${color('cyan', 'generate')} scaffold NAME f:t  Generate full CRUD resource
    ${color('cyan', 'server')}                      Start the dev server           ${color('dim', '(alias: s)')}
    ${color('cyan', 'console')}                     REPL with models loaded        ${color('dim', '(alias: c)')}
    ${color('cyan', 'routes')}                      List all routes
    ${color('cyan', 'db:migrate')}                  Run pending migrations
    ${color('cyan', 'db:rollback')}                 Roll back the last migration
    ${color('cyan', 'db:status')}                   Show migration status
    ${color('cyan', 'version')}                     Print the version

  ${color('bold', 'Field types:')} string text integer float boolean datetime references
`);
  },
};

const ALIASES = { g: 'generate', s: 'server', c: 'console', '--version': 'version', '-v': 'version', '--help': 'help', '-h': 'help' };

function getFlag(args, ...names) {
  for (const n of names) {
    const i = args.indexOf(n);
    if (i !== -1) return args[i + 1];
  }
  return null;
}

function fail(msg) {
  console.error(`\n  ${color('red', 'Error:')} ${msg}\n`);
  process.exitCode = 1;
}

async function main() {
  const [, , raw, ...args] = process.argv;
  const cmd = ALIASES[raw] || raw || 'help';
  const fn = commands[cmd];
  if (!fn) {
    fail(`Unknown command: ${raw}`);
    commands.help();
    return;
  }
  try {
    await fn(args);
  } catch (err) {
    fail(err.message);
    if (process.env.TRACKS_DEBUG) console.error(err.stack);
  }
}

main();
