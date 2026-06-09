'use strict';

// Proves the deploy-durability claim: a worker is SIGKILLed mid-job (exactly
// what happens to a pod during a deploy), and the job is NOT lost — another
// worker reclaims it after the visibility deadline and runs it to completion.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CRACK = path.join(__dirname, '..');
const database = require('../lib/database');
const { Queue, installSchema } = require('../lib/queue');

const VISIBILITY = 2000; // short so the demo is quick
const t0 = Date.now();
const at = () => `+${String(Date.now() - t0).padStart(4, ' ')}ms`;
const log = (m) => process.stdout.write(`  ${at()}  ${m}\n`);

// Child worker: claims the job, "starts processing" (hangs), and is then killed.
const CHILD = `
  const database = require('./lib/database');
  const { Queue } = require('./lib/queue');
  database.connect(process.env.KEEL_ROOT, 'test');
  const q = new Queue();
  q.reclaim();
  const job = q.claim('default', ${VISIBILITY});
  if (job) process.stdout.write('CLAIMED ' + job.id + ' attempt=' + job.attempts + '\\n');
  setInterval(() => {}, 1000); // "processing" — never finishes; we get SIGKILLed
`;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-deploy-'));
  const db = database.connect(tmp, 'test');
  installSchema(db);

  const q = new Queue();
  q.define('process_payment', async () => { /* fast, succeeds */ });
  const id = q.enqueue('process_payment', { amount: 4200 });
  log(`enqueued job #${id} (process_payment)`);

  // --- Worker A claims it, then dies mid-job (the "deploy") ---
  log('worker A starting…');
  const child = spawn('node', ['-e', CHILD], { cwd: CRACK, env: { ...process.env, KEEL_ROOT: tmp } });
  await new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      const s = d.toString().trim();
      if (s.startsWith('CLAIMED')) { log(`worker A claimed it (${s.split(' ').slice(2).join(' ')}) and began processing`); resolve(); }
    });
  });
  assert.equal(q.find(id).status, 'running');

  await new Promise((r) => setTimeout(r, 1000));
  child.kill('SIGKILL'); // 🛑 deploy kills the pod mid-job
  log('💥 worker A SIGKILLed mid-job (a deploy)');
  assert.equal(q.find(id).status, 'running', 'job is stranded in running…');
  log('   job is stranded in `running` — a naive queue would lose it here');

  // --- Worker B (the new pod) reclaims after the visibility deadline ---
  log('worker B polling… (waiting for visibility deadline to lapse)');
  const deadline = Date.now() + 6000;
  let done = null;
  while (Date.now() < deadline && !done) {
    const res = await q.runOnce({ visibilityMs: VISIBILITY });
    if (res && res.job.id === id && res.outcome === 'done') { done = res; break; }
    await new Promise((r) => setTimeout(r, 200));
  }

  const job = q.find(id);
  log(`worker B reclaimed and completed it → status=${job.status}, attempts=${job.attempts}`);

  assert.ok(done, 'job completed');
  assert.equal(job.status, 'done');
  assert.equal(job.attempts, 2, 'attempt 1 crashed, attempt 2 succeeded (at-least-once)');

  database.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`\n  \x1b[32m✓ No job lost across the simulated deploy.\x1b[0m Worker A died mid-job; worker B reclaimed and finished it.\n\n`);
}

main().catch((e) => { process.stderr.write(String(e.stack || e) + '\n'); process.exit(1); });
