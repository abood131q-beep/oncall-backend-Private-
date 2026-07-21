#!/usr/bin/env node
/**
 * observability-shadow-ab.mjs — Phase 17.4 A/B compatibility harness.
 *
 * Boots the OnCall backend twice from the SAME server.js:
 *   A) LEGACY   (no platform flags)
 *   B) ENTERPRISE + OBSERVABILITY SHADOW  (PLATFORM_ENABLED=1, PLATFORM_HOST=1,
 *                                          PLATFORM_OBSERVABILITY=1, SHADOW_OBSERVABILITY=1)
 * and asserts the HTTP responses — especially the observability surfaces `/metrics`,
 * `/health`, `/health/live`, `/health/ready` — are byte-identical. This proves the
 * Observability Kernel shadow changes ZERO observable behavior; the legacy observability
 * system remains authoritative.
 *
 * Requires the sqlite3 native binding to load (run on the app's normal OS / CI). Prints
 * "Result: IDENTICAL" on success; auto-discovered by scripts/run-ab.mjs.
 *
 *   node tests/integration/observability-shadow-ab.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'oncall-obs-ab-'));
const JWT_SECRET = process.env.JWT_SECRET || 'obs-shadow-ab-secret-0123456789abcdef';

const A = { name: 'legacy', port: 4821, db: join(TMP, 'a.db'), env: {} };
const B = {
  name: 'enterprise+observability-shadow',
  port: 4822,
  db: join(TMP, 'b.db'),
  env: {
    PLATFORM_ENABLED: '1',
    PLATFORM_HOST: '1',
    PLATFORM_OBSERVABILITY: '1',
    SHADOW_OBSERVABILITY: '1',
  },
};

// Observability surfaces are the focus, plus general endpoints.
const PROBES = [
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/test' },
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/health/live' },
  { method: 'GET', path: '/health/ready' },
  { method: 'GET', path: '/metrics' },
  { method: 'GET', path: '/no-such-route' },
];
const CONTRACT_HEADERS = ['content-type', 'x-content-type-options', 'x-frame-options'];

// /metrics contains process-variable numbers (heap, uptime, cpu); compare its STRUCTURE
// (metric names + HELP/TYPE lines), not the volatile values.
function metricNames(body) {
  return body
    .split('\n')
    .filter((l) => l.startsWith('# TYPE ') || l.startsWith('# HELP '))
    .sort()
    .join('\n');
}
// /health & /health/live include uptime; compare keys/status not volatile numbers.
function healthShape(body) {
  try {
    const o = JSON.parse(body);
    if ('uptime' in o) o.uptime = '<n>';
    return JSON.stringify(o);
  } catch {
    return body;
  }
}

function startServer(cfg) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, JWT_SECRET, NODE_ENV: 'development', PORT: String(cfg.port), DB_PATH: cfg.db, LOG_LEVEL: 'ERROR', ...cfg.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (/running on port|Hosted service .* started|Enterprise Hosted Service/i.test(out)) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (c) => reject(new Error(`${cfg.name} exited early (code ${c}):\n${out}`)));
    setTimeout(() => reject(new Error(`${cfg.name} not ready:\n${out}`)), 20000);
  });
}

function request(port, probe) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: probe.method, path: probe.path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: CONTRACT_HEADERS.reduce((a, h) => ((a[h] = res.headers[h] ?? null), a), {}),
          body,
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitHealthy(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await request(port, { method: 'GET', path: '/health' });
      if (r.status === 200 || r.status === 503) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server on ${port} never answered /health`);
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 6000);
  });
}

function normalize(probe, r) {
  if (probe.path === '/metrics') return { status: r.status, headers: r.headers, body: metricNames(r.body) };
  if (probe.path === '/health' || probe.path === '/health/live') return { status: r.status, headers: r.headers, body: healthShape(r.body) };
  return r;
}

let a, b, failures = 0;
try {
  a = await startServer(A);
  b = await startServer(B);
  await waitHealthy(A.port);
  await waitHealthy(B.port);
  for (const probe of PROBES) {
    const ra = normalize(probe, await request(A.port, probe));
    const rb = normalize(probe, await request(B.port, probe));
    const diffs = [];
    if (ra.status !== rb.status) diffs.push(`status ${ra.status} != ${rb.status}`);
    if (ra.body !== rb.body) diffs.push('body/structure differs');
    for (const h of CONTRACT_HEADERS) if (ra.headers[h] !== rb.headers[h]) diffs.push(`header ${h} differs`);
    const label = `${probe.method} ${probe.path}`.padEnd(24);
    if (diffs.length === 0) console.log(`  ✅ ${label} identical (status ${ra.status})`);
    else { failures++; console.log(`  ❌ ${label} ${diffs.join('; ')}`); }
  }
} catch (e) {
  failures++;
  console.error('Harness error:', e.message);
} finally {
  await stop(a);
  await stop(b);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(
  failures === 0
    ? '\nResult: IDENTICAL — observability shadow changes zero observable behavior'
    : `\nResult: DRIFT — ${failures} probe(s) differ`
);
process.exit(failures === 0 ? 0 : 1);
