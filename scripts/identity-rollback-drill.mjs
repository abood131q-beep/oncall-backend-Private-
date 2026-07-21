#!/usr/bin/env node
/**
 * identity-rollback-drill.mjs — Phase 20.b (ADR-047 Gate B2 criterion B2.3, prepared for 20.c).
 *
 * Verifies the ROLLBACK-SAFETY invariant that a staged rollback must satisfy: a session (JWT +
 * refresh token) minted BEFORE a flag flip remains valid AFTER it — i.e., flipping the identity
 * flag never forces clients to re-authenticate. It boots a server (state "before"), logs a user in,
 * then restarts the server with the identity flag toggled (state "after", same DB) and asserts the
 * SAME access token still verifies (200) and the SAME refresh token still rotates (200).
 *
 * NOTE: `IDENTITY_AUTHORITATIVE` is introduced in Phase 20.c; today it is a no-op, so this drill
 * currently proves rollback-safety across a shadow-flag flip (PLATFORM_IDENTITY/SHADOW_IDENTITY) and
 * reports IDENTITY_AUTHORITATIVE as NOT-YET-WIRED. In 20.c the same drill flips the authoritative
 * flag. Runs anywhere via the dev sqlite3-compat preload.
 *
 *   node scripts/identity-rollback-drill.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const authoritativeWired = (() => {
  try {
    return /IDENTITY_AUTHORITATIVE/.test(readFileSync(join(ROOT, 'src/config/index.js'), 'utf8'));
  } catch {
    return false;
  }
})();

function startServer({ port, dbPath, env }) {
  const child = spawn(process.execPath, ['--no-warnings', '-r', './tools/dev/sqlite3-compat.js', 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      JWT_SECRET: 'rollback-drill-secret-0123456789abcdef0123456789abcdef',
      ADMIN_PHONES: '11111111',
      PORT: String(port),
      DB_PATH: dbPath,
      LOG_LEVEL: 'ERROR',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  return { child, base: `http://127.0.0.1:${port}`, getLogs: () => logs };
}
async function waitHealthy(base, child) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { if ((await fetch(`${base}/health`)).status === 200) return; } catch { /* not up */ }
    if (child.exitCode !== null) break;
  }
  throw new Error(`server ${base} not healthy`);
}
async function call(base, method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}
function stop(s) { return new Promise((r) => { if (!s || s.child.killed) return r(); s.child.on('exit', () => r()); s.child.kill('SIGTERM'); setTimeout(() => { try { s.child.kill('SIGKILL'); } catch { /* ignore */ } r(); }, 5000); }); }

let failures = 0;
const line = (ok, msg) => { console.log(`  ${ok ? '✅' : '❌'} ${msg}`); if (!ok) failures++; };

const dir = mkdtempSync(join(tmpdir(), 'rollback-drill-'));
const dbPath = join(dir, 'oncall.db');
let before, after;
try {
  // BEFORE: shadow/authoritative "enabled" posture.
  before = startServer({ port: 4851, dbPath, env: { PLATFORM_IDENTITY: '1', SHADOW_IDENTITY: '1', IDENTITY_AUTHORITATIVE: '1' } });
  await waitHealthy(before.base, before.child);
  const login = await call(before.base, 'POST', '/login', { body: { phone: '99997777', name: 'RB' } });
  const token = login.body && login.body.token;
  const refresh = login.body && login.body.refreshToken;
  line(Boolean(token && refresh), 'minted session (access + refresh) in BEFORE state');
  await stop(before); before = null;

  // AFTER: rollback — flags OFF (legacy authoritative), SAME DB.
  after = startServer({ port: 4852, dbPath, env: { PLATFORM_IDENTITY: '0', SHADOW_IDENTITY: '0', IDENTITY_AUTHORITATIVE: '0' } });
  await waitHealthy(after.base, after.child);
  const verify = await call(after.base, 'GET', '/auth/verify', { token });
  line(verify.status === 200, `access token minted BEFORE still verifies AFTER rollback (status ${verify.status})`);
  const rotate = await call(after.base, 'POST', '/auth/refresh', { body: { refreshToken: refresh } });
  line(rotate.status === 200, `refresh token minted BEFORE still rotates AFTER rollback (status ${rotate.status})`);
} catch (e) {
  failures++;
  console.error('Drill error:', e.message);
} finally {
  await stop(before);
  await stop(after);
  rmSync(dir, { recursive: true, force: true });
}

const evidence = {
  criterion: 'ADR-047 Gate B2.3 — staged rollback, no client re-auth',
  phase: '20.b',
  generatedAt: new Date().toISOString(),
  identityAuthoritativeWired: authoritativeWired,
  note: authoritativeWired
    ? 'IDENTITY_AUTHORITATIVE is wired; drill flips it directly.'
    : 'IDENTITY_AUTHORITATIVE NOT-YET-WIRED (introduced in Phase 20.c); drill currently proves rollback-safety across the shadow-flag flip.',
  rollbackSafety: failures === 0 ? 'PASS — sessions minted before the flip remain valid after' : 'FAIL',
};
const outDir = join(ROOT, 'architecture/phase-20.b/evidence');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'rollback-drill-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');

console.log(failures === 0 ? '\nResult: PASS — rollback-safety invariant holds (no client re-auth)' : `\nResult: FAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
