'use strict';

const database = require('./database');

// Keel's in-house durable job queue — built on the SQL database, no Redis.
//
// Durability model (the Rails-8 Solid Queue / pgmq pattern):
//   • Jobs are rows. A worker CLAIMS one atomically and sets a visibility
//     deadline (`locked_until`). The claim increments `attempts` up front, so a
//     job whose worker dies still counts as an attempt (at-least-once).
//   • If a worker dies mid-job (e.g. a deploy SIGKILLs it), the row stays
//     `running` until `locked_until` passes, then RECLAIM resets it to `ready`
//     and another worker re-runs it. No job is lost across a deploy.
//   • Workers GRACEFUL-DRAIN on stop(): stop claiming, finish in-flight work.
//
// On SQLite the atomic claim is a single `UPDATE … WHERE id = (SELECT … LIMIT 1)
// RETURNING *` (statement-level atomic under SQLite's write lock). The Postgres
// driver will use `SELECT … FOR UPDATE SKIP LOCKED` for true multi-worker
// concurrency — same API, swapped underneath.

const TABLE = 'keel_jobs';

function nowIso() {
  return new Date().toISOString();
}
function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString();
}

// Create the jobs table. Called from a migration (preferred) or directly.
function installSchema(db = database.db()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'ready',
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      run_at TEXT NOT NULL,
      locked_until TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_claim ON ${TABLE} (status, queue, run_at);
  `);
}

class Queue {
  constructor(opts = {}) {
    this.handlers = new Map();
    this.queueName = opts.queue || 'default';
    this.baseBackoffMs = opts.baseBackoffMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
  }

  _db() {
    return database.db();
  }

  // Register a handler: Queue.define('send_email', async (payload, ctx) => {...})
  define(name, handler) {
    if (typeof handler !== 'function') throw new Error(`Job "${name}" handler must be a function`);
    this.handlers.set(name, handler);
    return this;
  }

  // Enqueue a job. opts: { queue, priority, maxAttempts, delay (ms), runAt (Date) }
  enqueue(name, payload = {}, opts = {}) {
    const now = nowIso();
    const runAt = opts.runAt
      ? new Date(opts.runAt).toISOString()
      : opts.delay
        ? isoIn(opts.delay)
        : now;
    const info = this._db()
      .prepare(
        `INSERT INTO ${TABLE} (queue, name, payload, status, priority, max_attempts, run_at, created_at, updated_at)
         VALUES (@queue, @name, @payload, 'ready', @priority, @maxAttempts, @runAt, @now, @now)`
      )
      .run({
        queue: opts.queue || this.queueName,
        name,
        payload: JSON.stringify(payload ?? {}),
        priority: opts.priority ?? 0,
        maxAttempts: opts.maxAttempts ?? 5,
        runAt,
        now,
      });
    return Number(info.lastInsertRowid);
  }

  // Reset rows whose worker died (running past their visibility deadline).
  reclaim() {
    return this._db()
      .prepare(
        `UPDATE ${TABLE} SET status='ready', locked_until=NULL, updated_at=@now
         WHERE status='running' AND locked_until IS NOT NULL AND locked_until < @now`
      )
      .run({ now: nowIso() }).changes;
  }

  // Atomically claim the next ready job for `queue`, or return null.
  claim(queue = this.queueName, visibilityMs = 30_000) {
    return this._db()
      .prepare(
        `UPDATE ${TABLE}
            SET status='running', attempts=attempts+1, locked_until=@lock, updated_at=@now
          WHERE id = (
            SELECT id FROM ${TABLE}
             WHERE status='ready' AND queue=@queue AND run_at <= @now
             ORDER BY priority DESC, run_at ASC, id ASC
             LIMIT 1
          )
        RETURNING *`
      )
      .get({ queue, now: nowIso(), lock: isoIn(visibilityMs) }) || null;
  }

  _backoffMs(attempts) {
    const ms = this.baseBackoffMs * 2 ** Math.max(0, attempts - 1);
    return Math.min(this.maxBackoffMs, ms);
  }

  _complete(job) {
    this._db()
      .prepare(`UPDATE ${TABLE} SET status='done', locked_until=NULL, finished_at=@now, updated_at=@now WHERE id=@id`)
      .run({ id: job.id, now: nowIso() });
  }

  _fail(job, err) {
    const message = (err && err.message) || String(err);
    if (job.attempts >= job.max_attempts) {
      this._db()
        .prepare(`UPDATE ${TABLE} SET status='failed', last_error=@e, locked_until=NULL, finished_at=@now, updated_at=@now WHERE id=@id`)
        .run({ id: job.id, e: message, now: nowIso() });
      return 'failed';
    }
    this._db()
      .prepare(`UPDATE ${TABLE} SET status='ready', last_error=@e, locked_until=NULL, run_at=@runAt, updated_at=@now WHERE id=@id`)
      .run({ id: job.id, e: message, runAt: isoIn(this._backoffMs(job.attempts)), now: nowIso() });
    return 'retry';
  }

  // Claim and run exactly one job. Returns { job, outcome } or null if idle.
  async runOnce({ queue = this.queueName, visibilityMs = 30_000 } = {}) {
    this.reclaim();
    const job = this.claim(queue, visibilityMs);
    if (!job) return null;

    const handler = this.handlers.get(job.name);
    if (!handler) {
      this._fail(job, new Error(`No handler registered for job "${job.name}"`));
      return { job, outcome: 'failed' };
    }
    try {
      const payload = JSON.parse(job.payload || '{}');
      await handler(payload, { job, attempt: job.attempts });
      this._complete(job);
      return { job, outcome: 'done' };
    } catch (err) {
      const outcome = this._fail(job, err);
      return { job, outcome };
    }
  }

  // Start a polling worker. Returns a handle with stop() for graceful drain.
  work({ queue = this.queueName, concurrency = 1, pollMs = 200, visibilityMs = 30_000 } = {}) {
    let running = true;
    let inFlight = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const loop = async () => {
      while (running) {
        let processed;
        try {
          inFlight++;
          processed = await this.runOnce({ queue, visibilityMs });
        } catch (err) {
          process.stderr.write(`[queue] worker error: ${err.stack || err}\n`);
        } finally {
          inFlight--;
        }
        if (!processed && running) await sleep(pollMs);
      }
    };

    const loops = Array.from({ length: concurrency }, () => loop());

    return {
      async stop() {
        running = false; // stop claiming
        await Promise.all(loops); // graceful drain: finish in-flight
      },
      get inFlight() {
        return inFlight;
      },
    };
  }

  // Inspection helpers (used by tests, Studio, and the MCP surface).
  stats(queue = this.queueName) {
    const rows = this._db()
      .prepare(`SELECT status, COUNT(*) n FROM ${TABLE} WHERE queue=@queue GROUP BY status`)
      .all({ queue });
    return rows.reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});
  }
  find(id) {
    return this._db().prepare(`SELECT * FROM ${TABLE} WHERE id=?`).get(id) || null;
  }
}

// ---- minimal 5-field cron matcher (min hr dom mon dow) ----
// Supports *, */n, a, a-b, and comma lists. Enough for first-class scheduling.
function matchField(field, value) {
  return field.split(',').some((part) => {
    if (part === '*') return true;
    if (part.startsWith('*/')) return value % Number(part.slice(2)) === 0;
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      return value >= a && value <= b;
    }
    return Number(part) === value;
  });
}
function cronMatches(expr, date) {
  const [min, hr, dom, mon, dow] = expr.trim().split(/\s+/);
  return (
    matchField(min, date.getMinutes()) &&
    matchField(hr, date.getHours()) &&
    matchField(dom, date.getDate()) &&
    matchField(mon, date.getMonth() + 1) &&
    matchField(dow, date.getDay())
  );
}

// In-process scheduler: ticks every interval, enqueues due cron entries (deduped
// per minute) and fixed-interval entries. Runs alongside (or inside) a worker.
class Scheduler {
  constructor(queue) {
    this.queue = queue;
    this.crons = []; // { expr, name, payload, lastMinute }
    this.intervals = []; // { ms, name, payload, timer }
    this.timer = null;
  }
  cron(expr, name, payload = {}) {
    this.crons.push({ expr, name, payload, lastMinute: null });
    return this;
  }
  every(ms, name, payload = {}) {
    this.intervals.push({ ms, name, payload });
    return this;
  }
  start(tickMs = 1000) {
    for (const i of this.intervals) {
      i.timer = setInterval(() => this.queue.enqueue(i.name, i.payload), i.ms);
    }
    this.timer = setInterval(() => {
      const d = new Date();
      const minuteKey = `${d.getHours()}:${d.getMinutes()}`;
      for (const c of this.crons) {
        if (c.lastMinute !== minuteKey && cronMatches(c.expr, d)) {
          c.lastMinute = minuteKey;
          this.queue.enqueue(c.name, c.payload);
        }
      }
    }, tickMs);
    return this;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const i of this.intervals) if (i.timer) clearInterval(i.timer);
  }
}

// Default singleton for ergonomic `Queue.define(...)` usage.
const defaultQueue = new Queue();

module.exports = {
  Queue,
  Scheduler,
  installSchema,
  cronMatches,
  // default-queue conveniences
  define: (...a) => defaultQueue.define(...a),
  enqueue: (...a) => defaultQueue.enqueue(...a),
  work: (...a) => defaultQueue.work(...a),
  runOnce: (...a) => defaultQueue.runOnce(...a),
  reclaim: (...a) => defaultQueue.reclaim(...a),
  stats: (...a) => defaultQueue.stats(...a),
  find: (...a) => defaultQueue.find(...a),
  defaultQueue,
};
