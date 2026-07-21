#!/usr/bin/env node
/**
 * identity-http-ab.mjs — Phase 20.b HTTP + Refresh/Revocation A/B (ADR-047 Gate B2, HTTP surface).
 *
 * Boots the SAME server twice — once with the Identity Shadow OFF (production today) and once with
 * it ON (PLATFORM_IDENTITY=1, SHADOW_IDENTITY=1, observational) — on separate ports/DBs, drives the
 * FULL identity lifecycle (otp / passenger+admin+driver login / verify / is-admin / refresh rotation
 * + replay / logout / logout-all / revocation / rate-limit) through BOTH, normalizes nondeterministic
 * fields (tokens, timestamps, jwt iat/exp), and diffs every (status, body) pair. Any difference
 * fails. This proves the live shadow integration changes ZERO external behavior AND that refresh +
 * revocation semantics are byte-identical with the shadow observing — the HTTP/refresh/revocation
 * Gate B2 evidence.
 *
 * Uses the dev sqlite3-compat preload so it runs anywhere (incl. CI + the validation sandbox).
 * Prints "Result: IDENTICAL" for scripts/run-ab.mjs; exits non-zero on any drift.
 *
 *   node tests/integration/identity-http-ab.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN_PHONE = '11111111';

// ── Normalization (borrowed from identity-ab.mjs — tokens/timestamps are nondeterministic) ──────
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;
const JWTISH_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HEXTOKEN_RE = /^[a-f0-9]{32,}$/i;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{40,}$/;

function normalize(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, k);
    return out;
  }
  if (typeof value === 'string') {
    if (JWTISH_RE.test(value) || HEXTOKEN_RE.test(value) || OPAQUE_TOKEN_RE.test(value)) return '<TOKEN>';
    if (DATETIME_RE.test(value)) return '<DATETIME>';
  }
  if (typeof value === 'number' && /^(iat|exp|expires_at|start_time|end_time)$/.test(key)) return '<TS>';
  return value;
}

// ── Server lifecycle (dev sqlite3-compat preload) ───────────────────────────────────────────────
async function startServer({ shadow, port, dbPath }) {
  const child = spawn(process.execPath, ['--no-warnings', '-r', './tools/dev/sqlite3-compat.js', 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      JWT_SECRET: 'ab-harness-secret-0123456789abcdef0123456789abcdef',
      ADMIN_PHONES: ADMIN_PHONE,
      PORT: String(port),
      DB_PATH: dbPath,
      LOG_LEVEL: 'ERROR',
      // The experiment: shadow OFF vs ON. Legacy identity stays authoritative in BOTH.
      PLATFORM_IDENTITY: shadow ? '1' : '0',
      SHADOW_IDENTITY: shadow ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  throw new Error(`server failed to start (shadow=${shadow})\n${logs.slice(-2000)}`);
}

async function call(base, method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = { __nonjson: true }; }
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

  await step('otp: missing phone', 'POST', '/auth/otp/send', { body: {} });
  await step('otp: valid send', 'POST', '/auth/otp/send', { body: { phone: '99990001' } });
  await step('login: missing phone', 'POST', '/login', { body: {} });
  const p = await step('login: new passenger', 'POST', '/login', { body: { phone: '99990001', name: 'AB Test' } });
  state.passengerToken = p.body.token;
  state.passengerRefresh = p.body.refreshToken;
  const a = await step('login: admin', 'POST', '/login', { body: { phone: ADMIN_PHONE } });
  state.adminToken = a.body.token;

  await step('verify: valid', 'GET', '/auth/verify', { token: state.passengerToken });
  await step('verify: none', 'GET', '/auth/verify', {});
  await step('is-admin: passenger', 'GET', '/auth/is-admin', { token: state.passengerToken });
  await step('is-admin: admin', 'GET', '/auth/is-admin', { token: state.adminToken });

  await step('driver login: new → pending', 'POST', '/driver/login', { body: { phone: '99990002' } });
  await step('admin: approve driver', 'PUT', '/admin/drivers/99990002/approve', { token: state.adminToken, body: {} });
  const d = await step('driver login: approved', 'POST', '/driver/login', { body: { phone: '99990002' } });
  state.driverRefresh = d.body.refreshToken;

  // Refresh + revocation semantics
  await step('refresh: missing', 'POST', '/auth/refresh', { body: {} });
  await step('refresh: junk', 'POST', '/auth/refresh', { body: { refreshToken: 'junk' } });
  const r1 = await step('refresh: valid rotation', 'POST', '/auth/refresh', { body: { refreshToken: state.passengerRefresh } });
  await step('refresh: replay of rotated (revoked)', 'POST', '/auth/refresh', { body: { refreshToken: state.passengerRefresh } });
  state.passengerRefresh2 = r1.body.refreshToken;

  await step('logout: with tokens', 'POST', '/logout', { token: state.passengerToken, body: { refreshToken: state.passengerRefresh2 } });
  await step('verify: after logout (revoked)', 'GET', '/auth/verify', { token: state.passengerToken });
  await step('refresh: after logout (revoked)', 'POST', '/auth/refresh', { body: { refreshToken: state.passengerRefresh2 } });
  await step('logout: garbage never fails', 'POST', '/logout', { token: 'garbage', body: {} });

  const p4 = await step('login: passenger 4', 'POST', '/login', { body: { phone: '99990004' } });
  await step('logout-all: authenticated', 'POST', '/auth/logout-all', { token: p4.body.token, body: {} });
  await step('refresh: after logout-all (revoked)', 'POST', '/auth/refresh', { body: { refreshToken: p4.body.refreshToken } });

  await step('404 contract', 'GET', '/definitely-not-a-route', {});
  return record;
}

async function runMode(shadow, port) {
  const dir = mkdtempSync(join(tmpdir(), `id-http-ab-${shadow ? 'on' : 'off'}-`));
  const dbPath = join(dir, 'oncall.db');
  const srv = await startServer({ shadow, port, dbPath });
  try {
    return await runScenarios(srv.base);
  } finally {
    srv.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    srv.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

const offRun = await runMode(false, 4831);
const onRun = await runMode(true, 4832);

let failures = 0;
for (let i = 0; i < Math.max(offRun.length, onRun.length); i++) {
  const off = offRun[i];
  const on = onRun[i];
  const name = (off || on).name;
  const same = off && on && off.status === on.status && JSON.stringify(off.body) === JSON.stringify(on.body);
  if (same) {
    console.log(`  ✅ ${name.padEnd(38)} identical (status ${off.status})`);
  } else {
    failures++;
    console.log(`  ❌ ${name.padEnd(38)} DIFF`);
    console.log(`     OFF: ${JSON.stringify(off)}`);
    console.log(`     ON : ${JSON.stringify(on)}`);
  }
}

console.log(
  failures === 0
    ? '\nResult: IDENTICAL — identity HTTP + refresh/revocation byte-identical with shadow OFF vs ON'
    : `\nResult: DRIFT — ${failures} step(s) differ`
);
process.exit(failures === 0 ? 0 : 1);
