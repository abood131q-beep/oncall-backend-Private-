#!/usr/bin/env node
/**
 * Users cutover A/B compatibility proof (Migration Phase 3).
 *
 * Boots the REAL server twice — legacy router (USERS_LEGACY=1) and the new
 * enterprise router — against fresh databases, drives an identical scenario
 * suite through both, normalizes nondeterministic fields (tokens, timestamps,
 * ids, jwt iat/exp), and diffs every (status, body) pair ORDER-SENSITIVELY
 * (JSON key order included). Any difference fails.
 *
 * Run: node tests/integration/users-ab.mjs
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
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{40,}$/;

function normalize(value, key = '') {
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
  if (typeof value === 'number' && /^(id|iat|exp|created_at|updated_at|trip_id)$/.test(key))
    return '<N>';
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
        USERS_LEGACY: legacy ? '1' : '0',
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

async function call(base, method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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

/** Login a passenger and return their access token. */
async function tokenFor(base, phone, name) {
  const r = await call(base, 'POST', '/login', { body: { phone, name } });
  return r.body.token;
}

// ── Scenario suite (identical for both servers) ──────────────────────────────
async function runScenarios(base) {
  const results = [];
  const rec = async (label, p) => results.push([label, await p]);

  // Seed: a passenger with a session, and a second passenger.
  const t = await tokenFor(base, '55500001', 'Alice');
  const other = '55500002';
  await tokenFor(base, other, 'Bob'); // ensure Bob exists

  // 1. Update profile (happy)
  await rec(
    'update:ok',
    call(base, 'POST', '/user/update', { token: t, body: { name: 'Alice2' } })
  );
  // 2. Update profile (no name → legacy passes undefined→NULL)
  await rec('update:noname', call(base, 'POST', '/user/update', { token: t, body: {} }));
  // 3. Update profile (no token → 401 from authenticate middleware)
  await rec('update:noauth', call(base, 'POST', '/user/update', { body: { name: 'X' } }));
  // 4. Balance self (ok)
  await rec('balance:self', call(base, 'GET', '/balance/55500001', { token: t }));
  // 5. Balance other phone (IDOR → 403)
  await rec('balance:idor', call(base, 'GET', `/balance/${other}`, { token: t }));
  // 6. Balance no token → 401
  await rec('balance:noauth', call(base, 'GET', '/balance/55500001', {}));
  // 7. balance/add deprecated → 410
  await rec(
    'balanceadd:410',
    call(base, 'POST', '/balance/add', { token: t, body: { amount: 5 } })
  );
  // 8. transactions (ignores path phone; returns array)
  await rec('tx:self', call(base, 'GET', '/transactions/55500001', { token: t }));
  // 9. transactions with someone else's phone in path (legacy still returns OWN)
  await rec('tx:otherpath', call(base, 'GET', `/transactions/${other}`, { token: t }));
  // 10. transactions no token → 401
  await rec('tx:noauth', call(base, 'GET', '/transactions/55500001', {}));
  // 11. notifications list
  await rec('notif:list', call(base, 'GET', '/notifications/55500001', { token: t }));
  // 12. notifications other path (still OWN)
  await rec('notif:otherpath', call(base, 'GET', `/notifications/${other}`, { token: t }));
  // 13. notifications mark read
  await rec('notif:read', call(base, 'PUT', '/notifications/55500001/read', { token: t }));
  // 14. notifications no token → 401
  await rec('notif:noauth', call(base, 'GET', '/notifications/55500001', {}));
  // 15. report (typed)
  await rec(
    'report:typed',
    call(base, 'POST', '/report', {
      token: t,
      body: { type: 'bug', description: 'issue here', trip_id: 7 },
    })
  );
  // 16. report (defaults: no type → 'general', no trip_id → null)
  await rec(
    'report:defaults',
    call(base, 'POST', '/report', { token: t, body: { description: 'no type' } })
  );
  // 17. report no token → 401
  await rec('report:noauth', call(base, 'POST', '/report', { body: { description: 'x' } }));

  return results;
}

// ── Runner ───────────────────────────────────────────────────────────────────
function stable(v) {
  return JSON.stringify(normalize(v));
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'users-ab-'));
  const legacyDb = join(dir, 'legacy.db');
  const newDb = join(dir, 'new.db');
  let legacy,
    next,
    fails = 0,
    total = 0;
  try {
    legacy = await startServer({ legacy: true, port: 4801, dbPath: legacyDb });
    next = await startServer({ legacy: false, port: 4802, dbPath: newDb });

    const a = await runScenarios(legacy.base);
    const b = await runScenarios(next.base);

    console.log(`\n  Users A/B compatibility — ${a.length} scenarios\n  ${'-'.repeat(52)}`);
    for (let i = 0; i < a.length; i++) {
      total++;
      const [label, ra] = a[i];
      const [, rb] = b[i];
      const sa = `${ra.status} ${stable(ra.body)}`;
      const sb = `${rb.status} ${stable(rb.body)}`;
      const ok = sa === sb;
      if (!ok) {
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
