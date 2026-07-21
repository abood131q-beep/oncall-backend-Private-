#!/usr/bin/env node
/**
 * identity-cross-replica-revocation.mjs — Phase 20.b (ADR-047 Gate B2 criterion B2.2).
 *
 * STAGING harness. Proves cross-replica revocation timing is unaffected by the Identity Shadow:
 * boots TWO replicas that share the same DB + Redis (REDIS_URL), logs a user in on replica A, revokes
 * all their tokens on A (`/auth/logout-all`), then polls `/auth/verify` on replica B and measures the
 * propagation time until B rejects the token — with the shadow OFF, then ON — asserting BOTH replicas
 * propagate the revocation and the ON timing is within tolerance of the OFF baseline.
 *
 * REQUIRES `REDIS_URL` (cross-instance propagation is a no-op without it — see middleware/auth.js
 * §Phase 12/C2 and onCallApplication.js). Without REDIS_URL this prints UNAVAILABLE and exits 0
 * (skip-clean) — it does NOT fabricate a result. Intended for CI-with-Redis / staging.
 *
 *   REDIS_URL=redis://localhost:6379 node tests/integration/identity-cross-replica-revocation.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REDIS_URL = process.env.REDIS_URL || '';
const TOLERANCE_MS = Number(process.env.XREPLICA_TOLERANCE_MS || 3000);

if (!REDIS_URL) {
  console.log('UNAVAILABLE — cross-replica revocation requires REDIS_URL (≥2 replicas + Redis).');
  console.log('Result: SKIPPED (set REDIS_URL in CI-with-Redis / staging to produce B2.2 evidence).');
  process.exit(0);
}

function startReplica({ name, port, dbPath, shadow }) {
  const child = spawn(process.execPath, ['--no-warnings', '-r', './tools/dev/sqlite3-compat.js', 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      JWT_SECRET: 'xreplica-secret-0123456789abcdef0123456789abcdef',
      ADMIN_PHONES: '11111111',
      PORT: String(port),
      DB_PATH: dbPath,
      REDIS_URL,
      LOG_LEVEL: 'ERROR',
      PLATFORM_IDENTITY: shadow ? '1' : '0',
      SHADOW_IDENTITY: shadow ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  return { child, base, getLogs: () => logs, name };
}

async function waitHealthy(base, child) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`${base}/health`);
      if (res.status === 200) return;
    } catch {
      /* not up */
    }
    if (child.exitCode !== null) break;
  }
  throw new Error(`replica ${base} not healthy`);
}

async function call(base, method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

function stop(rep) {
  try { rep.child.kill('SIGKILL'); } catch { /* ignore */ }
}

/** Returns { propagatedMs } or throws if B never rejects within the window. */
async function measurePropagation(shadow, portA, portB) {
  const dir = mkdtempSync(join(tmpdir(), `xrepl-${shadow ? 'on' : 'off'}-`));
  const dbPath = join(dir, 'shared.db');
  const A = startReplica({ name: 'A', port: portA, dbPath, shadow });
  const B = startReplica({ name: 'B', port: portB, dbPath, shadow });
  try {
    await waitHealthy(A.base, A.child);
    await waitHealthy(B.base, B.child);
    const login = await call(A.base, 'POST', '/login', { body: { phone: '99991234', name: 'X' } });
    const token = login.body && login.body.token;
    if (!token) throw new Error('login did not return a token');
    // Sanity: token valid on B before revocation.
    const pre = await call(B.base, 'GET', '/auth/verify', { token });
    if (pre.status !== 200) throw new Error(`token not valid on B pre-revocation (status ${pre.status})`);
    // Revoke on A, then poll B for rejection.
    const t0 = Date.now();
    await call(A.base, 'POST', '/auth/logout-all', { token, body: {} });
    let propagatedMs = -1;
    for (let i = 0; i < 200; i++) {
      const r = await call(B.base, 'GET', '/auth/verify', { token });
      if (r.status === 401) { propagatedMs = Date.now() - t0; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (propagatedMs < 0) throw new Error('revocation never propagated to replica B within window');
    return { propagatedMs };
  } finally {
    stop(A);
    stop(B);
    rmSync(dir, { recursive: true, force: true });
  }
}

let failures = 0;
const line = (ok, msg) => { console.log(`  ${ok ? '✅' : '❌'} ${msg}`); if (!ok) failures++; };

try {
  const off = await measurePropagation(false, 4841, 4842);
  const on = await measurePropagation(true, 4843, 4844);
  line(true, `propagation OFF = ${off.propagatedMs}ms`);
  line(true, `propagation ON  = ${on.propagatedMs}ms`);
  line(on.propagatedMs <= off.propagatedMs + TOLERANCE_MS, `ON within tolerance (+${TOLERANCE_MS}ms) of OFF baseline`);
} catch (e) {
  failures++;
  console.error('Harness error:', e.message);
}

console.log(failures === 0 ? '\nResult: PASS — cross-replica revocation timing unaffected by shadow' : `\nResult: FAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
