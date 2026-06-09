#!/usr/bin/env node
/**
 * perf-check.mjs
 *
 * Performance validation: measures response times for all key public URLs
 * (blob direct reads + API endpoints). All public pages must respond in < 500ms.
 *
 * Usage:
 *   BASE_URL="https://<your-swa>.azurestaticapps.net" \
 *   BLOB_BASE_URL="https://<storageaccount>.blob.core.windows.net/data" \
 *   node scripts/perf-check.mjs
 *
 * Optional:
 *   THRESHOLD_MS=500     Response time threshold in ms (default 500)
 *   ITERATIONS=3         Number of times to hit each URL (default 3, uses median)
 *
 * Exit code 0 = all URLs within threshold.
 * Exit code 1 = one or more URLs exceeded the threshold.
 */

const BASE_URL = process.env.BASE_URL?.replace(/\/$/, "");
const BLOB_BASE_URL = process.env.BLOB_BASE_URL?.replace(/\/$/, "");
const THRESHOLD_MS = Number(process.env.THRESHOLD_MS ?? 500);
const ITERATIONS = Number(process.env.ITERATIONS ?? 3);

if (!BASE_URL) {
  console.error("Missing BASE_URL env var (e.g. https://bccweb.azurestaticapps.net)");
  process.exit(1);
}
if (!BLOB_BASE_URL) {
  console.error(
    "Missing BLOB_BASE_URL env var (e.g. https://stbccwebprod.blob.core.windows.net/data)"
  );
  process.exit(1);
}

// ─── Target URLs ──────────────────────────────────────────────────────────────

/**
 * Each entry:  { label, url, group }
 * group = "blob" | "api"
 */
const targets = [
  // ── Blob direct reads (public data — the hot path) ──────────────────────
  { label: "rounds.json",       url: `${BLOB_BASE_URL}/rounds.json`,        group: "blob" },
  { label: "pilots.json",       url: `${BLOB_BASE_URL}/pilots.json`,        group: "blob" },
  { label: "clubs.json",        url: `${BLOB_BASE_URL}/clubs.json`,         group: "blob" },
  { label: "sites.json",        url: `${BLOB_BASE_URL}/sites.json`,         group: "blob" },
  { label: "seasons.json",      url: `${BLOB_BASE_URL}/seasons.json`,       group: "blob" },
  // ── API endpoints ────────────────────────────────────────────────────────
  { label: "GET /api/health",   url: `${BASE_URL}/api/health`,              group: "api"  },
  { label: "GET /api/rounds",   url: `${BASE_URL}/api/rounds`,              group: "api"  },
  { label: "GET /api/pilots",   url: `${BASE_URL}/api/pilots`,              group: "api"  },
  { label: "GET /api/seasons",  url: `${BASE_URL}/api/seasons`,             group: "api"  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Fetch a URL and return the elapsed time in ms.
 * Returns Infinity on fetch error.
 *
 * @param {string} url
 * @returns {Promise<number>}
 */
async function time(url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    await res.arrayBuffer(); // consume body so we measure full download
    return Math.round(performance.now() - t0);
  } catch {
    return Infinity;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`BCCWeb Performance Check  (threshold: ${THRESHOLD_MS}ms, iterations: ${ITERATIONS})`);
  console.log(`  Base URL:  ${BASE_URL}`);
  console.log(`  Blob URL:  ${BLOB_BASE_URL}`);
  console.log("");

  let anyFailed = false;

  // Group output
  let lastGroup = null;
  for (const target of targets) {
    if (target.group !== lastGroup) {
      console.log(`── ${target.group === "blob" ? "Blob direct reads" : "API endpoints"} ──`);
      lastGroup = target.group;
    }

    const times = [];
    for (let i = 0; i < ITERATIONS; i++) {
      times.push(await time(target.url));
    }

    const med = median(times);
    const label = target.label.padEnd(28);

    if (med === Infinity) {
      console.error(`  ✗  ${label}  ERROR (fetch failed after 10s)`);
      anyFailed = true;
    } else if (med > THRESHOLD_MS) {
      const samples = times.map((t) => `${t}ms`).join(", ");
      console.error(`  ✗  ${label}  ${med}ms  [${samples}]  — EXCEEDED ${THRESHOLD_MS}ms`);
      anyFailed = true;
    } else {
      const samples = times.map((t) => `${t}ms`).join(", ");
      console.log(`  ✓  ${label}  ${med}ms  [${samples}]`);
    }
  }

  console.log("");
  console.log("─────────────────────────────────────────");
  if (anyFailed) {
    console.error(`  Performance check FAILED — one or more URLs exceeded ${THRESHOLD_MS}ms.`);
    process.exit(1);
  } else {
    console.log(`  Performance check PASSED — all URLs responded within ${THRESHOLD_MS}ms.`);
  }
}

main().catch((err) => {
  console.error("Perf check crashed:", err.message);
  process.exit(1);
});
