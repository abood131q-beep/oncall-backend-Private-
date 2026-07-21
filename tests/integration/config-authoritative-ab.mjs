#!/usr/bin/env node
/**
 * config-authoritative-ab.mjs — Phase 18.5 / ADR-048 A/B compatibility harness.
 *
 * Boots the OnCall backend TWICE from the SAME server.js — once with CONFIG_AUTHORITATIVE=0
 * (config reads flow through env.js) and once with CONFIG_AUTHORITATIVE=1 (config reads flow
 * through the Configuration Kernel snapshot, env.js fallback) — on separate ports and separate
 * throwaway databases, then asserts a representative set of HTTP responses is byte-identical
 * (status + body + contract headers). This is the runtime gate proving the authoritative
 * Configuration promotion changes ZERO external behavior: identical HTTP responses, startup,
 * routing, auth-validation path, and Flutter-facing contract.
 *
 * NOTE: requires the sqlite3 native binding to load (run on the app's normal platform / CI, not a
 * cross-arch sandbox). Prints "Result: IDENTICAL" on success so scripts/run-ab.mjs picks it up;
 * exits non-zero on any drift. (The config-value equivalence and every fallback/fault path are
 * additionally proven in-process, sqlite-free, by tests/unit/configAuthoritative.test.js.)
 *
 *   node tests/integration/config-authoritative-ab.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'oncall-cfgauth-ab-'));
const JWT_SECRET = process.env.JWT_SECRET || 'ab-cfgauth-test-secret-0123456789abcdef';

// Same boot, ONLY the CONFIG_AUTHORITATIVE flag differs — that is the whole experiment.
const OFF = { name: 'config-off', port: 4811, db: join(TMP, 'off.db'), env: { CONFIG_AUTHORITATIVE: '0' } };
const ON = { name: 'config-on', port: 4812, db: join(TMP, 'on.db'), env: { CONFIG_AUTHORITATIVE: '1' } };

// Public, side-effect-free requests to compare (no auth, no writes) — these exercise config-
// derived behavior (CORS/health/metrics/env-reported fields) and the routing + validation paths.
const PROBES = [
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/test' },
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/health/live' },
  { method: 'GET', path: '/metrics' },
  { method: 'GET', path: '/definitely-not-a-route' }, // 404 contract
  { method: 'POST', path: '/auth/verify-otp', body: {} }, // validation-path contract (auth)
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

let off, on, failures = 0;
try {
  off = await startServer(OFF);
  on = await startServer(ON);
  await waitHealthy(OFF.port);
  await waitHealthy(ON.port);

  for (const probe of PROBES) {
    const a = await request(OFF.port, probe);
    const b = await request(ON.port, probe);
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
  await stop(off);
  await stop(on);
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(
  failures === 0
    ? '\nResult: IDENTICAL — CONFIG_AUTHORITATIVE=0 and =1 are byte-identical across probes'
    : `\nResult: DRIFT — ${failures} probe(s) differ`
);
process.exit(failures === 0 ? 0 : 1);
