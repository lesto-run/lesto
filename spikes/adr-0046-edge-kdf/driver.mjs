// ADR 0046 spike load driver. Fires requests at a target concurrency and
// reports the end-to-end latency distribution (client-side wall clock — the
// user-facing login latency the A6 gate scores). Fixed request overhead is
// measured separately via a near-zero-work endpoint so derive time can be
// isolated: derive ≈ p95(end-to-end) − overhead.
//
// Usage:
//   node driver.mjs <base> load  <path>            <concurrency> <total>
//   node driver.mjs <base> combined <backend> <loginConc> <loginTotal>
//
// `combined` runs `loginTotal` single-derive logins at `loginConc` concurrency
// WHILE firing recovery-code enrollments (10 serialized derives) in parallel —
// the ADR's "sustained combined load with the derive semaphore engaged" — and
// reports the LOGIN latency distribution under that contention.

const base = process.argv[2];
const mode = process.argv[3];

function pct(sorted, q) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

// Percentiles over the SUCCESSFUL requests only. A 503/1102 fails at the edge in
// ~RTT with no compute, so failures are the FASTEST samples and would deflate the
// distribution (the red-team caught this false-oracle: a "green" p95 while the
// majority errored). Callers pass ok-only latencies; failures are counted apart.
function stats(latencies) {
  const s = [...latencies].sort((a, b) => a - b);
  if (s.length === 0) return { n: 0 };
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: Math.round(s[0]),
    p50: Math.round(pct(s, 0.5)),
    p90: Math.round(pct(s, 0.9)),
    p95: Math.round(pct(s, 0.95)),
    p99: Math.round(pct(s, 0.99)),
    max: Math.round(s[s.length - 1]),
    mean: Math.round(sum / s.length),
  };
}

async function timeGet(path) {
  const t0 = performance.now();
  let status = 0;
  let ok = false;
  try {
    const res = await fetch(base + path);
    status = res.status;
    await res.arrayBuffer(); // drain
    ok = res.status === 200;
  } catch (e) {
    status = -1;
  }
  return { ms: performance.now() - t0, status, ok };
}

// Run `total` requests to `path`, keeping `concurrency` in flight.
async function pool(path, concurrency, total) {
  const results = [];
  let launched = 0;
  async function worker() {
    while (launched < total) {
      launched++;
      results.push(await timeGet(path));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function measureOverhead() {
  // /info does ~no work; its latency is the RTT + fixed request overhead floor.
  const r = await pool("/info", 4, 12);
  return stats(r.filter((x) => x.ok).map((x) => x.ms)).p50;
}

if (mode === "load") {
  const path = process.argv[4];
  const concurrency = Number(process.argv[5]);
  const total = Number(process.argv[6]);
  const overhead = await measureOverhead();
  const results = await pool(path, concurrency, total);
  const failed = results.filter((x) => !x.ok);
  const st = stats(results.filter((x) => x.ok).map((x) => x.ms)); // ok-only
  console.log(
    JSON.stringify(
      {
        path,
        concurrency,
        total,
        overheadMs: overhead,
        failed: failed.length,
        failRate: `${Math.round((100 * failed.length) / total)}%`,
        failStatuses: [...new Set(failed.map((x) => x.status))],
        endToEndMs_okOnly: st,
        deriveApproxMs_okOnly: st.n ? { p50: st.p50 - overhead, p95: st.p95 - overhead } : null,
      },
      null,
      2,
    ),
  );
} else if (mode === "combined") {
  const backend = process.argv[4];
  const loginConc = Number(process.argv[5]);
  const loginTotal = Number(process.argv[6]);
  const overhead = await measureOverhead();

  // Fire recovery enrollments in the background for the duration.
  let recoveryDone = false;
  const recoveryResults = [];
  const recoveryLoop = (async () => {
    while (!recoveryDone) {
      recoveryResults.push(await timeGet(`/recovery?backend=${backend}&codes=10`));
    }
  })();

  const loginResults = await pool(`/derive?backend=${backend}&count=1`, loginConc, loginTotal);
  recoveryDone = true;
  await recoveryLoop;

  const failed = loginResults.filter((x) => !x.ok);
  console.log(
    JSON.stringify(
      {
        scenario: "combined sustained load",
        backend,
        loginConcurrency: loginConc,
        loginTotal,
        overheadMs: overhead,
        loginFailed: failed.length,
        loginFailRate: `${Math.round((100 * failed.length) / loginTotal)}%`,
        loginFailStatuses: [...new Set(failed.map((x) => x.status))],
        loginEndToEndMs_okOnly: stats(loginResults.filter((x) => x.ok).map((x) => x.ms)),
        recoveryEnrollments: recoveryResults.length,
        recoveryFailed: recoveryResults.filter((x) => !x.ok).length,
        recoveryEndToEndMs_okOnly: stats(recoveryResults.filter((x) => x.ok).map((x) => x.ms)),
      },
      null,
      2,
    ),
  );
} else {
  console.error("unknown mode; use load|combined");
  process.exit(1);
}
