// ADR 0046 Phase-0 hard-gate spike — deployed-Worker argon2id benchmark.
//
// Measures, on a REAL deployed Cloudflare Worker (not miniflare, not Node — the
// `b932aa1` lesson), the two ratified routes at m=19456/t=2/p=1:
//   A-js   — @noble/hashes pure-JS argon2id (sync + async variants)
//   A-wasm — @phi-ag/argon2, wasm consumed as a DEPLOY-TIME MODULE IMPORT
//            (the only workerd-legal shape; runtime compile-from-bytes is the
//            thing IT4 probes below).
//
// Every route returns JSON with server-measured derive timings + an isolate id
// (so the driver can tell cold isolates apart) + a monotonic request counter.
// The driver (driver.mjs) drives sustained combined load and computes p50/p95.

import { argon2id, argon2idAsync } from "@noble/hashes/argon2.js";
import Argon2 from "@phi-ag/argon2";
// Deploy-time module import: wrangler's CompiledWasm rule turns this into a
// precompiled `WebAssembly.Module`. Instantiating a precompiled module at
// runtime is allowed on workerd; compiling from bytes is not (see /probe).
import argon2Module from "@phi-ag/argon2/argon2.wasm";

const M = 19456; // 19 MiB — the OWASP-2023 argon2id point the ADR pins
const T = 2;
const P = 1;
const DKLEN = 32;
const SALT = new Uint8Array(16).fill(7);
const PASSWORD = "correct horse battery staple";

// Lazy — random generation is disallowed in global scope on workerd. First
// request in a fresh isolate stamps this; a stable value across requests marks
// isolate reuse (so the driver can tell cold isolates apart).
let ISOLATE_ID = null;
const BOOTED_AT = Date.now();
let REQ_COUNT = 0;

// Per-isolate async semaphore (ADR IT2): concurrency-bounded, FIFO queue.
class Semaphore {
  #max;
  #active = 0;
  #queue = [];
  constructor(max) {
    this.#max = max;
  }
  async run(fn) {
    if (this.#active >= this.#max) {
      await new Promise((resolve) => this.#queue.push(resolve));
    }
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      const next = this.#queue.shift();
      if (next) next();
    }
  }
}

// Fresh wasm Instance per derive (own linear Memory), dropped after — the ADR's
// IT2 rule: wasm Memory cannot shrink, so a retained instance pins ~19 MiB
// forever. Holding N live instances concurrently is exactly the N×19 MiB
// pressure the memory-ceiling sweep exercises.
function wasmDeriveOnce(password, m, t, p) {
  const instance = new WebAssembly.Instance(argon2Module, {});
  const a = new Argon2(instance);
  const r = a.hash(password, {
    salt: SALT,
    hashLength: DKLEN,
    timeCost: t,
    memoryCost: m,
    parallelism: p,
    type: 2, // Argon2id
    version: 19, // 0x13
  });
  return r.hash;
}

function jsSyncDeriveOnce(password, m, t, p) {
  return argon2id(password, SALT, { t, m, p, dkLen: DKLEN });
}

function jsAsyncDeriveOnce(password, m, t, p) {
  return argon2idAsync(password, SALT, { t, m, p, dkLen: DKLEN });
}

function toHex(u8) {
  let s = "";
  for (const b of u8) s += b.toString(16).padStart(2, "0");
  return s;
}

// Run `count` derives, gating concurrency at `sem`. Returns per-derive wall ms
// (server-side; NOTE workerd freezes Date.now() during sync compute so these
// read ~0 — the AUTHORITATIVE timing is client-side + `wrangler tail` cpuTime),
// the total wall ms, and a hash sample for cross-runtime verify.
//
// `hold` matters for the MEMORY ceiling: sync derives (wasm, js-sync) complete
// synchronously inside their Promise.all slot, so N of them run sequentially and
// peak at ONE 19 MiB working set — they can't OOM by fan-out. To exercise the
// real N×19 MiB pressure with the wasm backend we must keep N Instances (each
// pinning its ~19 MiB linear Memory) alive simultaneously. `hold=1` does exactly
// that: build all N instances first, hash through each, keep the array live
// until return. js-async needs no hold — noble's async variant yields mid-derive
// while holding its ~19 MiB u32 buffer, so a plain fan-out already stacks N.
async function runDerives({ backend, count, sem, m, t, p, hold }) {
  const semaphore = new Semaphore(sem);
  const perDeriveMs = new Array(count);
  let sampleHex = null;
  const wallStart = Date.now();

  if (hold && backend === "wasm") {
    // Create all N instances up front (N × ~19 MiB live at once), then hash.
    const instances = Array.from({ length: count }, () => new WebAssembly.Instance(argon2Module, {}));
    const wrappers = instances.map((inst) => new Argon2(inst));
    for (let i = 0; i < count; i++) {
      const r = wrappers[i].hash(PASSWORD, {
        salt: SALT,
        hashLength: DKLEN,
        timeCost: t,
        memoryCost: m,
        parallelism: p,
        type: 2,
        version: 19,
      });
      if (i === 0) sampleHex = toHex(r.hash);
      perDeriveMs[i] = 0;
    }
    // Touch the array so it can't be optimized away before we return.
    return { totalMs: Date.now() - wallStart, perDeriveMs, sampleHex, held: wrappers.length };
  }

  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      semaphore.run(async () => {
        const d0 = Date.now();
        let out;
        if (backend === "wasm") out = wasmDeriveOnce(PASSWORD, m, t, p);
        else if (backend === "js-sync") out = jsSyncDeriveOnce(PASSWORD, m, t, p);
        else if (backend === "js-async") out = await jsAsyncDeriveOnce(PASSWORD, m, t, p);
        else throw new Error(`unknown backend ${backend}`);
        perDeriveMs[i] = Date.now() - d0;
        if (i === 0) sampleHex = toHex(out);
      }),
    ),
  );
  return { totalMs: Date.now() - wallStart, perDeriveMs, sampleHex };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request) {
    if (ISOLATE_ID === null) ISOLATE_ID = crypto.randomUUID();
    REQ_COUNT++;
    const reqNo = REQ_COUNT;
    const url = new URL(request.url);
    const path = url.pathname;
    const qs = url.searchParams;
    const num = (k, d) => {
      const v = qs.get(k);
      return v == null ? d : Number(v);
    };

    const m = num("m", M);
    const t = num("t", T);
    const p = num("p", P);
    const count = num("count", 1);
    const sem = num("sem", 3);

    const meta = { isolate: ISOLATE_ID, reqNo, ageMs: Date.now() - BOOTED_AT };

    try {
      if (path === "/info") {
        return json({ ...meta, m: M, t: T, p: P });
      }

      // IT4 — verify the workerd wasm code-generation restriction against
      // CURRENT workerd. Module-import instantiate must work; compile-from-bytes
      // and Module-from-bytes must be refused. We report exactly what happened.
      if (path === "/probe/wasm-codegen") {
        const result = {};
        // (a) Instantiate the deploy-time module import — must succeed.
        try {
          const inst = new WebAssembly.Instance(argon2Module, {});
          result.moduleImportInstantiate = { ok: true, hasExports: !!inst.exports };
        } catch (e) {
          result.moduleImportInstantiate = { ok: false, error: String(e) };
        }
        // Grab the raw bytes of a tiny valid module to feed the blocked APIs.
        // (\0asm + version header + empty body is a valid empty module.)
        const tiny = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
        // (b) new WebAssembly.Module(bytes) — compile from bytes at runtime.
        try {
          const mod = new WebAssembly.Module(tiny);
          result.moduleFromBytes = { ok: true, blocked: false };
          void mod;
        } catch (e) {
          result.moduleFromBytes = { ok: false, blocked: true, error: String(e) };
        }
        // (c) WebAssembly.compile(bytes) — async compile from bytes at runtime.
        try {
          await WebAssembly.compile(tiny);
          result.compileFromBytes = { ok: true, blocked: false };
        } catch (e) {
          result.compileFromBytes = { ok: false, blocked: true, error: String(e) };
        }
        return json({ ...meta, probe: result });
      }

      // Raw isolate memory ceiling: allocate `count` × 19 MiB ArrayBuffers,
      // touch one byte per 64 KiB page (force commit), hold all refs. Ground
      // truth for "how many 19 MiB live buffers fit" independent of any KDF.
      if (path === "/alloc") {
        const bufs = [];
        const bytes = m * 1024;
        for (let i = 0; i < count; i++) {
          const b = new Uint8Array(bytes);
          for (let o = 0; o < bytes; o += 65536) b[o] = (i + o) & 0xff;
          bufs.push(b);
        }
        let checksum = 0;
        for (const b of bufs) checksum = (checksum + b[0]) & 0xff;
        return json({ ...meta, count, mibEach: m / 1024, checksum });
      }

      // /derive?backend=js-sync|js-async|wasm&count=N&sem=S&hold=1
      if (path === "/derive") {
        const backend = qs.get("backend") || "wasm";
        const hold = qs.get("hold") === "1";
        const r = await runDerives({ backend, count, sem, m, t, p, hold });
        return json({ ...meta, backend, count, sem, m, t, p, hold, ...r });
      }

      // Recovery-code enrollment (confirmTotp): `codes` derives SERIALIZED
      // through the shared semaphore (ADR IT1 — never Promise.all fan-out).
      if (path === "/recovery") {
        const backend = qs.get("backend") || "wasm";
        const codes = num("codes", 10);
        const r = await runDerives({ backend, count: codes, sem: 1, m, t, p });
        return json({ ...meta, backend, codes, serialized: true, ...r });
      }

      // PBKDF2-100k baseline (the incumbent edge mint cost) for comparison.
      if (path === "/pbkdf2") {
        const enc = new TextEncoder();
        const semaphore = new Semaphore(sem);
        const perDeriveMs = new Array(count);
        const wallStart = Date.now();
        await Promise.all(
          Array.from({ length: count }, (_, i) =>
            semaphore.run(async () => {
              const d0 = Date.now();
              const key = await crypto.subtle.importKey(
                "raw",
                enc.encode(PASSWORD),
                "PBKDF2",
                false,
                ["deriveBits"],
              );
              await crypto.subtle.deriveBits(
                { name: "PBKDF2", hash: "SHA-256", salt: SALT, iterations: 100000 },
                key,
                256,
              );
              perDeriveMs[i] = Date.now() - d0;
            }),
          ),
        );
        return json({ ...meta, backend: "pbkdf2-100k", count, sem, totalMs: Date.now() - wallStart, perDeriveMs });
      }

      return json({ ...meta, routes: ["/info", "/probe/wasm-codegen", "/alloc", "/derive", "/recovery", "/pbkdf2"] });
    } catch (e) {
      return json({ ...meta, error: String(e), stack: e && e.stack ? String(e.stack) : null }, 500);
    }
  },
};
