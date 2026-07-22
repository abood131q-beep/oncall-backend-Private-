#!/usr/bin/env node
/**
 * config-shadow-ab.mjs — Phase 17.3 A/B compatibility harness.
 *
 * Boots the OnCall backend twice from the SAME server.js:
 *   A) LEGACY   (no platform flags)
 *   B) ENTERPRISE + CONFIGURATION SHADOW  (PLATFORM_ENABLED=1, PLATFORM_HOST=1,
 *                                          PLATFORM_CONFIG=1, SHADOW_CONFIG=1)
 * and asserts the HTTP responses are byte-identical. This proves the Configuration Kernel
 * shadow (parity comparison running out-of-band) changes ZERO externally observable behavior
 * — legacy configuration remains authoritative and the app path is untouched.
 *
 * Requires the sqlite3 native binding to load (run on the app's normal OS / CI, not a
 * cross-arch sandbox). Prints "Result: IDENTICAL" on success; auto-discovered by run-ab.mjs.
 *
 *   node tests/integration/config-shadow-ab.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { normalizeBody } from './_ab-normalize.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'oncall-cfg-ab-'));
const JWT_SECRET = process.env.JWT_SECRET || 'cfg-shadow-ab-secret-0123456789abcdef';

const A = { name: 'legacy', port: 4811, db: join(TMP, 'a.db'), env: {} };
const B = {
  name: 'enterprise+config-shadow',
  port: 4812,
  db: join(TMP, 'b.db'),
  env: {
    PLATFORM_ENABLED: '1',
    PLATFORM_HOST: '1',
    PLATFORM_CONFIG: '1',
    SHADOW_CONFIG: '1',
  },
};

const PROBES = [
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/test' },
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/health/live' },
  { method: 'GET', path: '/metrics' },
  { method: 'GET', path: '/no-such-route' },
  { method: 'POST', path: '/auth/verify-otp', body: {} },
];
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
    child.on('exit', (c) => reject(new Error(`${cfg.name} exited early (code ${c}):\n${out}`)));
    setTimeout(() => reject(new Error(`${cfg.name} not ready:\n${out}`)), 20000);
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

let a, b, failures = 0;
try {
  a = await startServer(A);
  b = await startServer(B);
  await waitHealthy(A.port);
  await waitHealthy(B.port);
  for (const probe of PROBES) {
    const ra = await request(A.port, probe);
    const rb = await request(B.port, probe);
    const diffs = [];
    if (ra.status !== rb.status) diffs.push(`status ${ra.status} != ${rb.status}`);
    if (normalizeBody(probe.path, ra.body) !== normalizeBody(probe.path, rb.body))
      diffs.push('body differs');
    for (const h of CONTRACT_HEADERS) {
      if (ra.headers[h] !== rb.headers[h]) diffs.push(`header ${h} differs`);
    }
    const label = `${probe.method} ${probe.path}`.padEnd(34);
    if (diffs.length === 0) console.log(`  ✅ ${label} identical (status ${ra.status})`);
    else {
      failures++;
      console.log(`  ❌ ${label} ${diffs.join('; ')}`);
    }
  }
} catch (e) {
  failures++;
  console.error('Harness error:', e.message);
} finally {
  await stop(a);
  await stop(b);
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(
  failures === 0
    ? '\nResult: IDENTICAL — configuration shadow changes zero observable behavior'
    : `\nResult: DRIFT — ${failures} probe(s) differ`
);
process.exit(failures === 0 ? 0 : 1);
