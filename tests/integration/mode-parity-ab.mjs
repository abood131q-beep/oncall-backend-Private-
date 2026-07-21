#!/usr/bin/env node
/**
 * mode-parity-ab.mjs — Phase 17.2 A/B compatibility harness.
 *
 * Boots the OnCall backend TWICE from the SAME server.js — once in LEGACY mode and once in
 * ENTERPRISE mode (PLATFORM_ENABLED=1, PLATFORM_HOST=1) — on separate ports and separate
 * throwaway databases, then asserts that a representative set of HTTP responses is
 * byte-identical (status + body + contract headers). This is the runtime gate proving the
 * Hosted Service changes zero external behavior.
 *
 * NOTE: requires the sqlite3 native binding to load in the current environment (i.e. run on
 * the app's normal platform / CI, not a cross-arch sandbox). Prints "Result: IDENTICAL" on
 * success so scripts/run-ab.mjs picks it up; exits non-zero on any drift.
 *
 *   node tests/integration/mode-parity-ab.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'oncall-ab-'));
const JWT_SECRET = process.env.JWT_SECRET || 'ab-parity-test-secret-0123456789abcdef';

const LEGACY = { name: 'legacy', port: 4801, db: join(TMP, 'legacy.db'), env: {} };
const ENTER = {
  name: 'enterprise',
  port: 4802,
  db: join(TMP, 'enterprise.db'),
  env: { PLATFORM_ENABLED: '1', PLATFORM_HOST: '1' },
};

// Public, side-effect-free requests to compare (no auth, no writes).
const PROBES = [
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/test' },
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/health/live' },
  { method: 'GET', path: '/metrics' },
  { method: 'GET', path: '/definitely-not-a-route' }, // 404 contract
  { method: 'POST', path: '/auth/verify-otp', body: {} }, // validation-path contract
];

// Headers that are part of the client contract (exclude volatile ones like Date, ETag,
// X-Request-ID, Content-Length which legitimately vary per request/run).
const CONTRACT_HEADERS = ['content-type', 'x-content-type-options', 'x-frame-options'];

function startServer(cfg) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        JWT_SECRET,
        NODE_ENV: 'development',
        PORT: String(cfg.port),
        DB_PATH: cfg.db,
        LOG_LEVEL: 'ERROR',
        ...cfg.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (/running on port|Hosted service .* started|Enterprise Hosted Service/i.test(out)) {
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`${cfg.name} exited early (code ${code}):\n${out}`)));
    setTimeout(() => reject(new Error(`${cfg.name} did not become ready:\n${out}`)), 20000);
  });
}

function request(port, probe) {
  return new Promise((resolve, reject) => {
    const payload = probe.body ? JSON.stringify(probe.body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: probe.method,
        path: probe.path,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: CONTRACT_HEADERS.reduce((a, h) => ((a[h] = res.headers[h] ?? null), a), {}),
            body,
          })
        );
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitHealthy(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await request(port, { method: 'GET', path: '/health' });
      if (r.status === 200 || r.status === 503) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server on ${port} never answered /health`);
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 6000);
  });
}

let legacy, enterprise, failures = 0;
try {
  legacy = await startServer(LEGACY);
  enterprise = await startServer(ENTER);
  await waitHealthy(LEGACY.port);
  await waitHealthy(ENTER.port);

  for (const probe of PROBES) {
    const a = await request(LEGACY.port, probe);
    const b = await request(ENTER.port, probe);
    const diffs = [];
    if (a.status !== b.status) diffs.push(`status ${a.status} != ${b.status}`);
    if (a.body !== b.body) diffs.push('body differs');
    for (const h of CONTRACT_HEADERS) {
      if (a.headers[h] !== b.headers[h]) diffs.push(`header ${h}: "${a.headers[h]}" != "${b.headers[h]}"`);
    }
    const label = `${probe.method} ${probe.path}`.padEnd(34);
    if (diffs.length === 0) {
      console.log(`  ✅ ${label} identical (status ${a.status})`);
    } else {
      failures++;
      console.log(`  ❌ ${label} ${diffs.join('; ')}`);
    }
  }
} catch (e) {
  failures++;
  console.error('Harness error:', e.message);
} finally {
  await stop(legacy);
  await stop(enterprise);
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(
  failures === 0
    ? '\nResult: IDENTICAL — legacy and enterprise modes are byte-identical across probes'
    : `\nResult: DRIFT — ${failures} probe(s) differ`
);
process.exit(failures === 0 ? 0 : 1);
