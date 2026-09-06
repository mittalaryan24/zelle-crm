/**
 * Runs every suite in order and reports one summary.
 *
 *   node scripts/test-all.mjs [baseUrl]      (or: npm test)
 *
 * Ordering matters. check-funnel needs nothing; the RLS and write suites need
 * the database; the two smoke suites need the dev server; and check-roundrobin
 * mutates users.is_active and ingests real leads, so it runs LAST and restores
 * what it touched — anything after it would race its cleanup.
 *
 * WHY THIS FILE FINDS THE PORT ITSELF
 * `next dev` moves to 3001, 3002... when 3000 is taken, and this machine has
 * more than one Next project on it. A suite pointed at the wrong port does not
 * fail cleanly: it gets someone else's 404s and reports them as assertion
 * failures, which reads exactly like a regression in this app. Same lesson as
 * scripts/Test-Ingest.ps1 — identify the server, do not assume it.
 *
 * WHY IT HEALTH-CHECKS BETWEEN SUITES
 * A dev server that has gone unresponsive produces the same symptom: a suite
 * full of confusing failures. Checking first means the runner can say "the
 * server stopped responding" instead of blaming the code.
 */
import { spawnSync } from "node:child_process";

const CANDIDATE_PORTS = [3001, 3000, 3002, 3003];

async function isOurApp(base) {
  try {
    const res = await fetch(`${base}/api/ingest/lead`, {
      method: "OPTIONS",
      signal: AbortSignal.timeout(3000),
    });
    // The ingest route stamps this on every response it produces (Stage 2).
    // Something merely answering on the port is not good enough.
    return res.headers.get("x-ingest-route") === "lead";
  } catch {
    return false;
  }
}

async function resolveBase() {
  const explicit = process.argv[2];
  if (explicit) {
    if (!(await isOurApp(explicit))) {
      console.log(`\nWarning: ${explicit} did not identify itself as this app. Continuing anyway.`);
    }
    return explicit;
  }

  for (const port of CANDIDATE_PORTS) {
    const base = `http://localhost:${port}`;
    if (await isOurApp(base)) return base;
  }
  return null;
}

const BASE = await resolveBase();

if (!BASE) {
  console.error(
    `\nCould not find the dev server on ports ${CANDIDATE_PORTS.join(", ")}.\n` +
      `Start it with 'npm run dev', note the port it prints, then either re-run\n` +
      `or pass it explicitly:  node scripts/test-all.mjs http://localhost:3005\n`,
  );
  process.exit(1);
}

console.log(`\nUsing ${BASE}`);

const SUITES = [
  { name: "funnel maths (no I/O)",    cmd: ["--experimental-strip-types", "scripts/check-funnel.mjs"], needsServer: false },
  { name: "RLS read scoping",         cmd: ["scripts/check-rls.mjs"],          needsServer: false },
  { name: "lead write paths",         cmd: ["scripts/check-writes.mjs"],       needsServer: false },
  { name: "admin write paths",        cmd: ["scripts/check-admin-writes.mjs"], needsServer: false },
  { name: "staff UI (Stage 3)",       cmd: ["scripts/smoke-ui.mjs", BASE],     needsServer: true },
  { name: "admin UI (Stage 4)",       cmd: ["scripts/smoke-admin.mjs", BASE],  needsServer: true },
  { name: "round-robin vs is_active", cmd: ["scripts/check-roundrobin.mjs", BASE], needsServer: true },
];

const results = [];

for (const suite of SUITES) {
  if (suite.needsServer && !(await isOurApp(BASE))) {
    console.log(`\n${"=".repeat(64)}\n${suite.name}\n${"=".repeat(64)}`);
    console.log("  SKIPPED — the dev server stopped responding.");
    results.push({ name: suite.name, ok: false, note: "server unresponsive" });
    continue;
  }

  process.stdout.write(`\n${"=".repeat(64)}\n${suite.name}\n${"=".repeat(64)}\n`);
  const run = spawnSync(process.execPath, suite.cmd, { stdio: "inherit" });
  results.push({ name: suite.name, ok: run.status === 0 });
}

console.log(`\n${"=".repeat(64)}\nSUMMARY\n${"=".repeat(64)}`);
for (const r of results) {
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? `  (${r.note})` : ""}`);
}
const failedCount = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failedCount}/${results.length} suites passed\n`);
process.exit(failedCount === 0 ? 0 : 1);
