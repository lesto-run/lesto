'use strict';

// Tests for Keel's in-house DB queue + scheduler + DB-lifecycle tooling
// (seeding helpers, transactional testing, deterministic masking).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const database = require('../lib/database');
const { Queue, Scheduler, installSchema, cronMatches } = require('../lib/queue');
const { transaction } = require('../lib/testing');
const { maskValue, maskTable } = require('../lib/masking');

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`); })
    .catch((err) => { failed++; process.stdout.write(`  \x1b[31m✗ ${name}\x1b[0m\n    ${err.message}\n`); });
}
function section(s) { process.stdout.write(`\n\x1b[1m${s}\x1b[0m\n`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-queue-'));
const db = database.connect(tmp, 'test');
installSchema(db);
db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT, ssn TEXT)`);

async function main() {
  section('Queue — lifecycle');

  await test('enqueue + runOnce completes a job', async () => {
    const q = new Queue();
    const seen = [];
    q.define('greet', async (payload) => { seen.push(payload.name); });
    const id = q.enqueue('greet', { name: 'Ada' });
    const res = await q.runOnce();
    assert.equal(res.outcome, 'done');
    assert.deepEqual(seen, ['Ada']);
    assert.equal(q.find(id).status, 'done');
  });

  await test('idle queue returns null', async () => {
    const q = new Queue({ queue: 'empty-q' });
    assert.equal(await q.runOnce({ queue: 'empty-q' }), null);
  });

  await test('failure retries with backoff (attempt counted, rescheduled)', async () => {
    const q = new Queue();
    q.define('boom', async () => { throw new Error('kaboom'); });
    const id = q.enqueue('boom', {});
    const res = await q.runOnce();
    assert.equal(res.outcome, 'retry');
    const job = q.find(id);
    assert.equal(job.status, 'ready');
    assert.equal(job.attempts, 1);
    assert.ok(job.last_error.includes('kaboom'));
    assert.ok(new Date(job.run_at) > new Date(), 'rescheduled into the future (backoff)');
  });

  await test('exhausting max_attempts marks failed', async () => {
    const q = new Queue();
    q.define('always_fail', async () => { throw new Error('nope'); });
    const id = q.enqueue('always_fail', {}, { maxAttempts: 1 });
    const res = await q.runOnce();
    assert.equal(res.outcome, 'failed');
    assert.equal(q.find(id).status, 'failed');
  });

  await test('missing handler fails the job (no crash)', async () => {
    const q = new Queue();
    const id = q.enqueue('unregistered', {}, { maxAttempts: 1 });
    const res = await q.runOnce();
    assert.equal(res.outcome, 'failed');
    assert.ok(q.find(id).last_error.includes('No handler'));
  });

  section('Queue — durability (reclaim)');

  await test('a job stuck running past its lock is reclaimed', async () => {
    const q = new Queue();
    q.define('slow', async () => {});
    const id = q.enqueue('slow', {});
    const claimed = q.claim('default', 30_000); // worker takes it
    assert.equal(claimed.id, id);
    assert.equal(q.find(id).status, 'running');
    // Simulate the worker dying: backdate the visibility deadline into the past.
    db.prepare(`UPDATE keel_jobs SET locked_until=? WHERE id=?`).run(new Date(Date.now() - 1000).toISOString(), id);
    assert.equal(q.reclaim(), 1);
    assert.equal(q.find(id).status, 'ready', 'reclaimed back to ready — not lost');
  });

  await test('priority + readiness ordering', async () => {
    const q = new Queue({ queue: 'ord' });
    const order = [];
    q.define('p', async (pl) => order.push(pl.tag));
    q.enqueue('p', { tag: 'low' }, { queue: 'ord', priority: 0 });
    q.enqueue('p', { tag: 'high' }, { queue: 'ord', priority: 10 });
    await q.runOnce({ queue: 'ord' });
    await q.runOnce({ queue: 'ord' });
    assert.deepEqual(order, ['high', 'low']);
  });

  await test('delayed jobs are not claimed early', async () => {
    const q = new Queue({ queue: 'delay-q' });
    q.define('later', async () => {});
    q.enqueue('later', {}, { queue: 'delay-q', delay: 60_000 });
    assert.equal(await q.runOnce({ queue: 'delay-q' }), null);
  });

  section('Scheduler — cron matching');

  await test('cronMatches every-minute and specific', () => {
    const d = new Date('2026-06-08T09:30:00');
    assert.equal(cronMatches('* * * * *', d), true);
    assert.equal(cronMatches('30 9 * * *', d), true);
    assert.equal(cronMatches('31 9 * * *', d), false);
    assert.equal(cronMatches('*/15 * * * *', d), true); // 30 % 15 === 0
    assert.equal(cronMatches('*/7 * * * *', d), false);
  });

  await test('Scheduler.every enqueues', async () => {
    const q = new Queue({ queue: 'sched' });
    q.define('tick', async () => {});
    const s = new Scheduler(q);
    s.every(10, 'tick', {});
    s.start(5);
    await new Promise((r) => setTimeout(r, 35));
    s.stop();
    assert.ok((q.stats('sched').ready || 0) >= 2, 'enqueued multiple ticks');
  });

  section('DB lifecycle — transactional testing');

  await test('transaction() rolls back all writes', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM users').get().n;
    await transaction(async () => {
      db.prepare(`INSERT INTO users (email, full_name) VALUES ('x@y.com','X Y')`).run();
      assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, before + 1);
    });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, before, 'rolled back to clean state');
  });

  section('DB lifecycle — masking');

  await test('maskers are deterministic + referentially stable', () => {
    assert.equal(maskValue('ada@corp.com', 'email'), maskValue('ada@corp.com', 'email'));
    assert.notEqual(maskValue('ada@corp.com', 'email'), 'ada@corp.com');
    assert.match(maskValue('ada@corp.com', 'email'), /^user_[0-9a-f]{8}@example\.com$/);
    assert.equal(maskValue('secret', 'redact'), '████████');
  });

  await test('maskTable masks PII in place, preserving joins', () => {
    db.prepare(`INSERT INTO users (id, email, full_name, ssn) VALUES (1,'ada@corp.com','Ada Lovelace','111-22-3333')`).run();
    db.prepare(`INSERT INTO users (id, email, full_name, ssn) VALUES (2,'ada@corp.com','Ada Again','999-00-1111')`).run();
    const n = maskTable(db, 'users', { email: 'email', full_name: 'fullName', ssn: 'redact' });
    assert.equal(n, 2);
    const [u1, u2] = db.prepare('SELECT * FROM users ORDER BY id').all();
    assert.notEqual(u1.email, 'ada@corp.com');
    assert.equal(u1.email, u2.email, 'same source email → same masked value (referential integrity)');
    assert.equal(u1.ssn, '████████');
  });

  database.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`\n${'='.repeat(40)}\n  \x1b[32m${passed} passed\x1b[0m${failed ? `, \x1b[31m${failed} failed\x1b[0m` : ''}\n${'='.repeat(40)}\n`);
  process.exit(failed ? 1 : 0);
}

main();
