'use strict';

// A dependency-free test runner for the Tracks framework itself. Runs against
// an in-memory SQLite DB so it's fast and leaves nothing behind.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const database = require('../lib/database');
const { Model } = require('../lib/model');
const { Migrator } = require('../lib/migrator');
const { draw } = require('../lib/router');
const inflector = require('../lib/inflector');
const { compile, escapeHtml } = require('../lib/view');
const { expandNested, parseBody } = require('../lib/params');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write(`  \x1b[31m✗ ${name}\x1b[0m\n    ${err.message}\n`);
  }
}
function section(s) {
  process.stdout.write(`\n\x1b[1m${s}\x1b[0m\n`);
}

// ---- set up a throwaway DB with two related tables ----
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-test-'));
const db = database.connect(tmpRoot, 'test');
const migDir = path.join(tmpRoot, 'db', 'migrate');
fs.mkdirSync(migDir, { recursive: true });
fs.writeFileSync(path.join(migDir, '0001_create_authors.js'), `module.exports = {
  up(s) { s.createTable('authors', t => { t.string('name'); t.timestamps(); }); },
  down(s) { s.dropTable('authors'); },
};`);
fs.writeFileSync(path.join(migDir, '0002_create_posts.js'), `module.exports = {
  up(s) { s.createTable('posts', t => { t.string('title'); t.text('body'); t.boolean('published'); t.references('author'); t.timestamps(); }); },
  down(s) { s.dropTable('posts'); },
};`);

const registry = require('../lib/registry');
class Author extends Model {
  static associations = { posts: { hasMany: 'Post' } };
}
class Post extends Model {
  static validations = { title: { presence: true, length: { min: 3 } } };
  static associations = { author: { belongsTo: 'Author' } };
  beforeSave() { this._touched = (this._touched || 0) + 1; }
}
registry.register('Author', Author);
registry.register('Post', Post);

// ============ INFLECTOR ============
section('Inflector');
test('pluralize', () => {
  assert.equal(inflector.pluralize('post'), 'posts');
  assert.equal(inflector.pluralize('category'), 'categories');
  assert.equal(inflector.pluralize('person'), 'people');
  assert.equal(inflector.pluralize('quiz'), 'quizzes');
});
test('singularize', () => {
  assert.equal(inflector.singularize('posts'), 'post');
  assert.equal(inflector.singularize('categories'), 'category');
  assert.equal(inflector.singularize('people'), 'person');
});
test('tableize / classify', () => {
  assert.equal(inflector.tableize('BlogPost'), 'blog_posts');
  assert.equal(inflector.classify('blog_posts'), 'BlogPost');
});
test('camelize / underscore', () => {
  assert.equal(inflector.camelize('blog_post'), 'BlogPost');
  assert.equal(inflector.underscore('BlogPost'), 'blog_post');
});

// ============ MIGRATOR ============
section('Migrator');
test('runs pending migrations', () => {
  const m = new Migrator(db, migDir);
  const applied = m.migrate();
  assert.equal(applied.length, 2);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'").get());
});
test('is idempotent (no double-apply)', () => {
  const m = new Migrator(db, migDir);
  assert.equal(m.migrate().length, 0);
});
test('reports status', () => {
  const m = new Migrator(db, migDir);
  assert.equal(m.status().filter((s) => s.up).length, 2);
});

// ============ MODEL: CRUD ============
section('Model — persistence');
test('create + find', () => {
  const a = Author.create({ name: 'Ada' });
  assert.ok(a.id > 0);
  assert.equal(Author.find(a.id).name, 'Ada');
});
test('find throws RecordNotFound', () => {
  assert.throws(() => Post.find(99999), /RecordNotFound|Couldn't find/);
});
test('update persists', () => {
  const a = Author.create({ name: 'Grace' });
  a.update({ name: 'Grace Hopper' });
  assert.equal(Author.find(a.id).name, 'Grace Hopper');
});
test('destroy removes the row', () => {
  const a = Author.create({ name: 'Temp' });
  const id = a.id;
  a.destroy();
  assert.throws(() => Author.find(id));
});
test('timestamps auto-populate', () => {
  const a = Author.create({ name: 'Linus' });
  assert.ok(a.created_at);
  assert.ok(a.updated_at);
});
test('booleans round-trip as 0/1', () => {
  const p = Post.create({ title: 'Bool test', published: true });
  assert.equal(Post.find(p.id).published, 1);
});

// ============ MODEL: validations ============
section('Model — validations');
test('rejects invalid records', () => {
  const p = new Post({ title: '' });
  assert.equal(p.save(), false);
  assert.ok(!p.errors.isEmpty);
  assert.deepEqual(p.errors.on('title')[0], "can't be blank");
});
test('length validation', () => {
  const p = new Post({ title: 'ab' });
  assert.equal(p.save(), false);
  assert.ok(p.errors.full().some((m) => /too short/.test(m)));
});
test('valid records save', () => {
  const p = new Post({ title: 'Valid title' });
  assert.equal(p.save(), true);
  assert.ok(p.isPersisted);
});

// ============ MODEL: callbacks ============
section('Model — callbacks');
test('beforeSave fires', () => {
  const p = new Post({ title: 'Callback test' });
  p.save();
  assert.equal(p._touched, 1);
});

// ============ MODEL: query builder ============
section('Relation — query builder');
test('where + order + limit chain', () => {
  Post.create({ title: 'AAA', published: true });
  Post.create({ title: 'BBB', published: false });
  const published = Post.where({ published: true }).order('title', 'asc').all();
  assert.ok(published.length >= 1);
  assert.ok(published.every((p) => p.published === 1));
});
test('where with IN clause', () => {
  const titles = Post.where({ title: ['AAA', 'BBB'] }).pluck('title');
  assert.ok(titles.includes('AAA') && titles.includes('BBB'));
});
test('count / first / last', () => {
  assert.ok(Post.count() > 0);
  assert.ok(Post.first().id < Post.last().id);
});
test('findBy', () => {
  assert.equal(Post.findBy({ title: 'AAA' }).title, 'AAA');
});
test('raw where with params', () => {
  const some = Post.where('title = ?', 'AAA').all();
  assert.ok(some.length >= 1);
});

// ============ ASSOCIATIONS ============
section('Associations');
test('belongsTo + hasMany', () => {
  const author = Author.create({ name: 'Margaret' });
  const p1 = Post.create({ title: 'First', author_id: author.id });
  Post.create({ title: 'Second', author_id: author.id });

  // belongsTo
  assert.equal(p1.author().name, 'Margaret');
  // hasMany
  const theirPosts = author.posts().all();
  assert.equal(theirPosts.length, 2);
  assert.deepEqual(theirPosts.map((p) => p.title).sort(), ['First', 'Second']);
});

// ============ ROUTER ============
section('Router');
test('RESTful resources generate 7 actions', () => {
  const r = draw((m) => m.resources('posts'));
  const actions = new Set(r.list().map((x) => x.to));
  ['posts#index', 'posts#show', 'posts#new', 'posts#create', 'posts#edit', 'posts#update', 'posts#destroy']
    .forEach((a) => assert.ok(actions.has(a), `missing ${a}`));
});
test('route resolution + param extraction', () => {
  const r = draw((m) => m.resources('posts'));
  const match = r.resolve('GET', '/posts/42');
  assert.equal(match.route.action, 'show');
  assert.equal(match.params.id, '42');
});
test('named path generation', () => {
  const r = draw((m) => m.resources('posts'));
  assert.equal(r.pathFor('post', { id: 7 }), '/posts/7');
  assert.equal(r.pathFor('edit_post', { id: 7 }), '/posts/7/edit');
});
test('custom verbs + root', () => {
  const r = draw((m) => {
    m.root('home#index');
    m.get('/about', 'pages#about');
    m.post('/login', 'sessions#create');
  });
  assert.equal(r.resolve('GET', '/').route.to ?? `${r.resolve('GET','/').route.controller}#${r.resolve('GET','/').route.action}`, 'home#index');
  assert.equal(r.resolve('GET', '/about').route.action, 'about');
  assert.equal(r.resolve('POST', '/login').route.action, 'create');
});
test('nested resources', () => {
  const r = draw((m) => m.resources('posts', (p) => p.resources('comments')));
  const match = r.resolve('GET', '/posts/3/comments/8');
  assert.equal(match.route.action, 'show');
  assert.equal(match.params.post_id, '3');
  assert.equal(match.params.id, '8');
});

// ============ VIEW ENGINE ============
section('View engine');
test('interpolation + escaping', () => {
  const fn = compile('<h1><%= title %></h1>');
  assert.equal(fn({ title: 'Hi & <b>bye</b>' }, escapeHtml), '<h1>Hi &amp; &lt;b&gt;bye&lt;/b&gt;</h1>');
});
test('raw output', () => {
  const fn = compile('<%- html %>');
  assert.equal(fn({ html: '<b>x</b>' }, escapeHtml), '<b>x</b>');
});
test('control flow', () => {
  const fn = compile('<% for (const n of nums) { %><i><%= n %></i><% } %>');
  assert.equal(fn({ nums: [1, 2, 3] }, escapeHtml), '<i>1</i><i>2</i><i>3</i>');
});

// ============ PARAMS ============
section('Params');
test('nested bracket params', () => {
  const parsed = expandNested([['post[title]', 'Hi'], ['post[body]', 'Yo']]);
  assert.deepEqual(parsed, { post: { title: 'Hi', body: 'Yo' } });
});
test('JSON body parsing', () => {
  assert.deepEqual(parseBody('{"a":1}', 'application/json'), { a: 1 });
});

// ---- summary ----
database.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });

process.stdout.write(`\n${'='.repeat(40)}\n`);
process.stdout.write(`  \x1b[32m${passed} passed\x1b[0m`);
if (failed) process.stdout.write(`, \x1b[31m${failed} failed\x1b[0m`);
process.stdout.write(`\n${'='.repeat(40)}\n`);
process.exit(failed ? 1 : 0);
