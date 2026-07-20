#!/usr/bin/env node
/**
 * Identity cutover A/B compatibility proof (Migration Phase 2).
 *
 * Boots the REAL server twice — legacy router (IDENTITY_LEGACY=1) and the new
 * enterprise router — against fresh databases, drives an identical scenario
 * suite through both, normalizes nondeterministic fields (tokens, timestamps,
 * jwt iat/exp), and diffs every (status, body) pair. Any difference fails.
 *
 * Run: node tests/integration/identity-ab.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN_PHONE = '11111111';

// ── Normalization ────────────────────────────────────────────────────────────
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;
const JWTISH_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HEXTOKEN_RE = /^[a-f0-9]{32,}$/i;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{40,}$/; // base64url refresh tokens

function normalize(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, k);
    return out;
  }
  if (typeof value === 'string') {
    if (JWTISH_RE.test(value) || HEXTOKEN_RE.test(value) || OPAQUE_TOKEN_RE.test(value))
      return '<TOKEN>';
    if (DATETIME_RE.test(value)) return '<DATETIME>';
  }
  if (typeof value === 'number' && /^(iat|exp|expires_at|start_time|end_time)$/.test(key))
    return '<TS>';
  return value;
}

// ── Server lifecycle ─────────────────────────────────────────────────────────
async function startServer({ legacy, port, dbPath }) {
  const child = spawn(
    process.execPath,
    ['--no-warnings', '-r', './tools/dev/sqlite3-compat.js', 'server.js'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        JWT_SECRET: 'ab-harness-secret-0123456789abcdef0123456789abcdef',
        ADMIN_PHONES: ADMIN_PHONE,
        PORT: String(port),
        DB_PATH: dbPath,
        LOG_LEVEL: 'ERROR',
        IDENTITY_LEGACY: legacy ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`${base}/health`);
      if (res.status === 200) return { child, base, getLogs: () => logs };
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) break;
  }
  child.kill('SIGKILL');
  throw new Error(`server failed to start (legacy=${legacy})\n${logs.slice(-2000)}`);
}

// ── Scenario driver ──────────────────────────────────────────────────────────
async function call(base, method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = { __nonjson: true };
  }
  return { status: res.status, body: json };
}

async function runScenarios(base) {
  const record = [];
  const state = {};
  const step = async (name, method, path, opts) => {
    const r = await call(base, method, path, opts);
    record.push({ name, status: r.status, body: normalize(r.body) });
    return r;
  };

  // Input validation
  await step('otp: missing phone', 'POST', '/auth/otp/send', { body: {} });
  await step('otp: invalid phone', 'POST', '/auth/otp/send', { body: { phone: 'not-a-phone!' } });
  await step('otp: valid send', 'POST', '/auth/otp/send', { body: { phone: '99990001' } });
  await step('login: missing phone', 'POST', '/login', { body: {} });
  await step('login: invalid phone', 'POST', '/login', { body: { phone: 'zz' } });

  // Passenger login (implicit registration)
  const p = await step('login: new passenger', 'POST', '/login', {
    body: { phone: '99990001', name: 'AB Test' },
  });
  state.passengerToken = p.body.token;
  state.passengerRefresh = p.body.refreshToken;

  // Admin login — frozen contract: no refresh token
  const a = await step('login: admin', 'POST', '/login', { body: { phone: ADMIN_PHONE } });
  state.adminToken = a.body.token;

  // Session queries
  await step('verify: valid', 'GET', '/auth/verify', { token: state.passengerToken });
  await step('verify: none', 'GET', '/auth/verify', {});
  await step('is-admin: passenger', 'GET', '/auth/is-admin', { token: state.passengerToken });
  await step('is-admin: admin', 'GET', '/auth/is-admin', { token: state.adminToken });
  await step('is-admin: none', 'GET', '/auth/is-admin', {});

  // Driver lifecycle (pending → approved → suspended) via admin surface
  await step('driver login: new → pending', 'POST', '/driver/login', {
    body: { phone: '99990002' },
  });
  await step('admin: approve driver', 'PUT', '/admin/drivers/99990002/approve', {
    token: state.adminToken,
    body: {},
  });
  const d = await step('driver login: approved', 'POST', '/driver/login', {
    body: { phone: '99990002' },
  });
  state.driverRefresh = d.body.refreshToken;
  await step('admin: suspend driver', 'PUT', '/admin/drivers/99990002/suspend', {
    token: state.adminToken,
    body: { reason: 'AB reason' },
  });
  await step('driver login: suspended', 'POST', '/driver/login', { body: { phone: '99990002' } });

  // Refresh semantics
  await step('refresh: missing', 'POST', '/auth/refresh', { body: {} });
  await step('refresh: junk', 'POST', '/auth/refresh', { body: { refreshToken: 'junk' } });
  const r1 = await step('refresh: valid rotation', 'POST', '/auth/refresh', {
    body: { refreshToken: state.passengerRefresh },
  });
  await step('refresh: replay of rotated token', 'POST', '/auth/refresh', {
    body: { refreshToken: state.passengerRefresh },
  });
  state.passengerRefresh2 = r1.body.refreshToken;
  // P6-06: suspended driver refresh → blocked AND revoked
  await step('refresh: suspended driver blocked', 'POST', '/auth/refresh', {
    body: { refreshToken: state.driverRefresh },
  });
  await step('refresh: suspended driver replay (revoked)', 'POST', '/auth/refresh', {
    body: { refreshToken: state.driverRefresh },
  });

  // Suspended passenger
  await step('login: create passenger 3', 'POST', '/login', { body: { phone: '99990003' } });
  await step('admin: toggle user 3 off', 'PUT', '/admin/users/99990003/toggle', {
    token: state.adminToken,
    body: {},
  });
  await step('login: suspended passenger', 'POST', '/login', { body: { phone: '99990003' } });

  // Logout semantics
  await step('logout: with tokens', 'POST', '/logout', {
    token: state.passengerToken,
    body: { refreshToken: state.passengerRefresh2 },
  });
  await step('verify: after logout (revoked)', 'GET', '/auth/verify', {
    token: state.passengerToken,
  });
  await step('refresh: after logout (revoked)', 'POST', '/auth/refresh', {
    body: { refreshToken: state.passengerRefresh2 },
  });
  await step('logout: garbage never fails', 'POST', '/logout', {
    token: 'garbage',
    body: {},
  });
  await step('logout-all: unauthenticated', 'POST', '/auth/logout-all', { body: {} });
  const p4 = await step('login: passenger 4', 'POST', '/login', { body: { phone: '99990004' } });
  await step('logout-all: authenticated', 'POST', '/auth/logout-all', {
    token: p4.body.token,
    body: {},
  });
  await step('refresh: after logout-all', 'POST', '/auth/refresh', {
    body: { refreshToken: p4.body.refreshToken },
  });

  // Rate limiting parity — per-phone limit (15/5min): drive one phone to 429
  let firstLimited = -1;
  for (let i = 0; i < 18; i++) {
    const r = await call(base, 'POST', '/login', { body: { phone: '99990009' } });
    if (r.status === 429 && firstLimited === -1) {
      firstLimited = i + 1;
      record.push({ name: 'ratelimit: first 429 attempt#', status: 429, body: { at: firstLimited, msg: normalize(r.body) } });
    }
  }
  if (firstLimited === -1)
    record.push({ name: 'ratelimit: first 429 attempt#', status: 0, body: { at: null } });

  return record;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function runMode(legacy, port) {
  const dir = mkdtempSync(join(tmpdir(), `ab-${legacy ? 'legacy' : 'new'}-`));
  const dbPath = join(dir, 'oncall.db');
  const srv = await startServer({ legacy, port, dbPath });
  try {
    return await runScenarios(srv.base);
  } finally {
    srv.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    srv.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

const legacyRun = await runMode(true, 3181);
const newRun = await runMode(false, 3182);

let failures = 0;
for (let i = 0; i < Math.max(legacyRun.length, newRun.length); i++) {
  const L = legacyRun[i];
  const N = newRun[i];
  const same = L && N && L.name === N.name && JSON.stringify(L) === JSON.stringify(N);
  if (same) {
    console.log(`PASS  ${L.name}  [${L.status}]`);
  } else {
    failures++;
    console.log(`FAIL  ${(L || N).name}`);
    console.log(`  legacy: ${JSON.stringify(L)}`);
    console.log(`  new:    ${JSON.stringify(N)}`);
  }
}
console.log(
  `\n${failures === 0 ? '✅ A/B COMPATIBILITY: IDENTICAL' : `❌ ${failures} DIFFERENCE(S)`} — ${legacyRun.length} scenarios compared`
);
process.exit(failures === 0 ? 0 : 1);
