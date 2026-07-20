#!/usr/bin/env node
/**
 * Notifications cutover A/B compatibility proof (Migration Phase 6).
 *
 * Boots the REAL server twice — legacy router (NOTIFICATIONS_LEGACY=1) and the
 * new enterprise router — on fresh databases, drives an identical scenario suite
 * through both, normalizes nondeterministic fields, and diffs every (status,
 * body) pair ORDER-SENSITIVELY (JSON key order included). Any difference fails.
 *
 * Run: node tests/integration/notifications-ab.mjs
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
const VOLATILE_KEYS = /^(id|last_seen|created_at|updated_at)$/;

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
  if (VOLATILE_KEYS.test(key)) return '<V>';
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
        NOTIFICATIONS_LEGACY: legacy ? '1' : '0',
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

async function tokenFor(base, phone, name) {
  return (await call(base, 'POST', '/login', { body: { phone, name } })).body.token;
}

async function runScenarios(base) {
  const out = [];
  const rec = async (label, p) => out.push([label, await p]);

  const admin = await tokenFor(base, ADMIN_PHONE, 'Admin');
  const user = await tokenFor(base, '55566601', 'User');
  const TOK = 'dGVzdC1kZXZpY2UtdG9rZW4tMTIzNDU2Nzg5MA';

  // Register device token
  await rec(
    'register:ok',
    call(base, 'POST', '/device-tokens', {
      token: user,
      body: { device_token: TOK, platform: 'android', app_version: '1.2.3' },
    })
  );
  await rec(
    'register:idempotent',
    call(base, 'POST', '/device-tokens', {
      token: user,
      body: { device_token: TOK, platform: 'android', app_version: '1.2.4' },
    })
  );
  await rec(
    'register:notoken',
    call(base, 'POST', '/device-tokens', { token: user, body: { platform: 'android' } })
  );
  await rec(
    'register:badplatform',
    call(base, 'POST', '/device-tokens', {
      token: user,
      body: { device_token: TOK, platform: 'windows' },
    })
  );
  await rec(
    'register:toolong',
    call(base, 'POST', '/device-tokens', {
      token: user,
      body: { device_token: 'x'.repeat(600), platform: 'ios' },
    })
  );
  await rec(
    'register:noauth',
    call(base, 'POST', '/device-tokens', { body: { device_token: TOK, platform: 'android' } })
  );
  // Delete device token
  await rec(
    'delete:existing',
    call(base, 'DELETE', '/device-tokens', { token: user, body: { device_token: TOK } })
  );
  await rec(
    'delete:missing',
    call(base, 'DELETE', '/device-tokens', { token: user, body: { device_token: 'nonexistent' } })
  );
  await rec('delete:notoken', call(base, 'DELETE', '/device-tokens', { token: user, body: {} }));
  await rec(
    'delete:noauth',
    call(base, 'DELETE', '/device-tokens', { body: { device_token: TOK } })
  );
  // Push send (admin) — notifService not configured in harness → deterministic result
  await rec(
    'push:send:ok',
    call(base, 'POST', '/push/send', {
      token: admin,
      body: { phone: '55566601', title: 'Hi', body: 'msg', data: { type: 'x' } },
    })
  );
  await rec(
    'push:send:missing',
    call(base, 'POST', '/push/send', { token: admin, body: { phone: '55566601' } })
  );
  await rec(
    'push:send:notadmin',
    call(base, 'POST', '/push/send', { token: user, body: { phone: '1', title: 't', body: 'b' } })
  );
  await rec(
    'push:send:noauth',
    call(base, 'POST', '/push/send', { body: { phone: '1', title: 't', body: 'b' } })
  );
  // Broadcast (admin)
  await rec(
    'push:bcast:ok',
    call(base, 'POST', '/push/broadcast', {
      token: admin,
      body: { phones: ['55566601', '55566602'], title: 'Hi', body: 'all' },
    })
  );
  await rec(
    'push:bcast:empty',
    call(base, 'POST', '/push/broadcast', {
      token: admin,
      body: { phones: [], title: 'Hi', body: 'all' },
    })
  );
  await rec(
    'push:bcast:toobig',
    call(base, 'POST', '/push/broadcast', {
      token: admin,
      body: { phones: Array.from({ length: 1001 }, (_, i) => String(i)), title: 'Hi', body: 'all' },
    })
  );
  await rec(
    'push:bcast:notadmin',
    call(base, 'POST', '/push/broadcast', {
      token: user,
      body: { phones: ['1'], title: 't', body: 'b' },
    })
  );
  // Admin list device tokens
  await rec('list:tokens', call(base, 'GET', '/device-tokens/55566601', { token: admin }));
  await rec('list:noauth', call(base, 'GET', '/device-tokens/55566601', {}));
  await rec('list:notadmin', call(base, 'GET', '/device-tokens/55566601', { token: user }));
  return out;
}

const stable = (v) => JSON.stringify(normalize(v));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'notif-ab-'));
  let legacy,
    next,
    fails = 0,
    total = 0;
  try {
    legacy = await startServer({ legacy: true, port: 4911, dbPath: join(dir, 'legacy.db') });
    next = await startServer({ legacy: false, port: 4912, dbPath: join(dir, 'new.db') });
    const a = await runScenarios(legacy.base);
    const b = await runScenarios(next.base);
    console.log(`\n  Notifications A/B compatibility — ${a.length} scenarios\n  ${'-'.repeat(52)}`);
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
