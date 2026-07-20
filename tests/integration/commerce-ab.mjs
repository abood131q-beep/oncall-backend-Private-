#!/usr/bin/env node
/**
 * Commerce cutover A/B compatibility proof (Migration Phase 11).
 *
 * Boots the REAL server twice — legacy payment router (COMMERCE_LEGACY=1) and the
 * new enterprise Commerce router — on fresh databases with PAYMENT_ENABLED=true,
 * so the FULL wallet lifecycle is exercised: methods catalog, charge (validation
 * 400 / success credit + ledger + notification / balance reflected), wallet
 * history, balance query, IDOR (403), and additive-English localization. Diffs
 * every (status, body) pair ORDER-SENSITIVELY, normalizing only host/run-volatile
 * fields (ids, timestamps). Financial figures (balances, amounts) are compared
 * as real values — the whole point of a Commerce proof.
 *
 * Run: node tests/integration/commerce-ab.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN_PHONE = '11111111';

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;
const JWTISH_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{40,}$/;
// A transaction row id and its timestamps are autoincrement/wall-clock → volatile.
// NOTE: balances and amounts are NOT normalized — they must match exactly.
const VOLATILE_KEYS = /^(id|trip_id|created_at|updated_at)$/;

function normalize(value, key = '') {
  if (VOLATILE_KEYS.test(key)) return '<V>';
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, k);
    return out;
  }
  if (typeof value === 'string') {
    if (JWTISH_RE.test(value) || OPAQUE_TOKEN_RE.test(value)) return '<TOKEN>';
    if (DATETIME_RE.test(value)) return '<DATETIME>';
  }
  return value;
}

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
        PAYMENT_ENABLED: 'true', // exercise the full charge lifecycle in both arms
        COMMERCE_LEGACY: legacy ? '1' : '0',
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
      if ((await fetch(`${base}/health`)).status === 200) return { child, base };
    } catch {
      /* not up */
    }
    if (child.exitCode !== null) break;
  }
  child.kill('SIGKILL');
  throw new Error(`server failed (legacy=${legacy})\n${logs.slice(-1500)}`);
}

async function call(base, method, path, { body, token, lang } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(lang ? { 'accept-language': lang } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function login(base, phone, name) {
  return (await call(base, 'POST', '/login', { body: { phone, name } })).body;
}

async function runScenarios(base) {
  const out = [];
  const rec = async (label, p) => out.push([label, await p]);

  const alice = (await login(base, '55590001', 'Alice')).token;
  const bob = (await login(base, '55590002', 'Bob')).token;

  // Payment methods (no auth)
  await rec('methods', call(base, 'GET', '/payment/methods'));

  // Balance / history — fresh user (balance defaults)
  await rec('balance:self', call(base, 'GET', '/wallet/balance/55590001', { token: alice }));
  await rec('balance:idor', call(base, 'GET', '/wallet/balance/55590002', { token: alice }));
  await rec(
    'txns:self:empty',
    call(base, 'GET', '/wallet/transactions/55590001', { token: alice })
  );
  await rec('txns:idor', call(base, 'GET', '/wallet/transactions/55590002', { token: alice }));

  // Charge validation
  await rec(
    'charge:zero',
    call(base, 'POST', '/wallet/charge', { token: alice, body: { amount: 0 } })
  );
  await rec(
    'charge:over',
    call(base, 'POST', '/wallet/charge', { token: alice, body: { amount: 501 } })
  );
  await rec(
    'charge:neg',
    call(base, 'POST', '/wallet/charge', { token: alice, body: { amount: -5 } })
  );
  // ADR-003: Arabic must stay byte-identical even when a client sends a header.
  // (English is additive-only; the legacy router has no i18n, so we assert the
  // Arabic default is preserved rather than comparing an English response the
  // legacy arm cannot produce.)
  await rec(
    'charge:zero:ar-header',
    call(base, 'POST', '/wallet/charge', { token: alice, body: { amount: 0 }, lang: 'ar' })
  );
  await rec('charge:noauth', call(base, 'POST', '/wallet/charge', { body: { amount: 5 } }));

  // Charge success — credits the wallet + writes a ledger row + notifies
  await rec(
    'charge:ok',
    call(base, 'POST', '/wallet/charge', { token: alice, body: { amount: 12.5, method: 'knet' } })
  );
  await rec(
    'charge:ok:2',
    call(base, 'POST', '/wallet/charge', { token: alice, body: { amount: 7.25, method: 'visa' } })
  );

  // Balance + history now reflect the settlement (exact figures compared)
  await rec('balance:after', call(base, 'GET', '/wallet/balance/55590001', { token: alice }));
  await rec('txns:after', call(base, 'GET', '/wallet/transactions/55590001', { token: alice }));

  // A second user's balance/history stays independent
  await rec('bob:balance', call(base, 'GET', '/wallet/balance/55590002', { token: bob }));

  return out;
}

const stable = (v) => JSON.stringify(normalize(v));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'commerce-ab-'));
  let legacy,
    next,
    fails = 0,
    total = 0;
  try {
    legacy = await startServer({ legacy: true, port: 4961, dbPath: join(dir, 'legacy.db') });
    next = await startServer({ legacy: false, port: 4962, dbPath: join(dir, 'new.db') });
    const a = await runScenarios(legacy.base);
    const b = await runScenarios(next.base);
    console.log(`\n  Commerce A/B compatibility — ${a.length} scenarios\n  ${'-'.repeat(52)}`);
    for (let i = 0; i < a.length; i++) {
      total++;
      const [label, ra] = a[i];
      const [, rb] = b[i];
      const sa = `${ra.status} ${stable(ra.body)}`;
      const sb = `${rb.status} ${stable(rb.body)}`;
      if (sa !== sb) {
        fails++;
        console.log(`  ✗ ${label}\n     legacy: ${sa}\n     new:    ${sb}`);
      } else {
        console.log(`  ✓ ${label}  [${ra.status}]`);
      }
    }
    console.log(`  ${'-'.repeat(52)}\n  Result: ${total - fails}/${total} byte-identical\n`);
  } finally {
    legacy?.child.kill('SIGKILL');
    next?.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
