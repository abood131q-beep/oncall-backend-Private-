#!/usr/bin/env node
/**
 * Trips cutover A/B compatibility proof (Migration Phase 7).
 *
 * Boots the REAL server twice — legacy taxi router (TRIPS_LEGACY=1) and the new
 * enterprise router — on fresh databases, drives an identical scenario suite
 * through both (full trip lifecycle: request → accept → arrive → in_progress →
 * complete → rate; plus reject/cancel/location/history/auth), normalizes
 * nondeterministic fields, and diffs every (status, body) pair ORDER-SENSITIVELY.
 *
 * Run: node tests/integration/trips-ab.mjs
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
// Trip timing / ids / fares / live stats are wall-clock/row dependent → normalized.
const VOLATILE_KEYS =
  /^(id|trip_id|driver_id|user_id|created_at|updated_at|end_time|start_time|request_sent_at|estimated_fare|final_fare|estimatedFare|finalFare|duration_minutes|total_distance|distanceKm|durationMinutes|currentFare|liveStats|time)$/;

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
        TRIPS_LEGACY: legacy ? '1' : '0',
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

async function login(base, phone, name) {
  return (await call(base, 'POST', '/login', { body: { phone, name } })).body;
}
async function approveDriver(base, admin, phone) {
  await call(base, 'POST', '/driver/login', { body: { phone } }); // create pending
  await call(base, 'PUT', `/admin/drivers/${phone}/approve`, { token: admin });
  return (await call(base, 'POST', '/driver/login', { body: { phone } })).body.token;
}

async function runScenarios(base) {
  const out = [];
  const rec = async (label, p) => out.push([label, await p]);

  const admin = (await login(base, ADMIN_PHONE, 'Admin')).token;
  const pa = (await login(base, '55540001', 'Alice')).token;
  const pb = (await login(base, '55540002', 'Bob')).token;
  const drv = await approveDriver(base, admin, '55540101');

  // Co-located + lists
  await rec('taxis:list', call(base, 'GET', '/taxis'));
  await rec('requests:empty', call(base, 'GET', '/taxi/requests', { token: drv }));
  await rec('driver:trips', call(base, 'GET', '/taxi/trips', { token: drv }));
  await rec('passenger:trips', call(base, 'GET', '/taxi/trips/passenger/55540001', { token: pa }));
  // Create trip — validation
  await rec(
    'create:missing',
    call(base, 'POST', '/taxi/request', { token: pa, body: { pickup: 'A' } })
  );
  await rec(
    'create:badpickup',
    call(base, 'POST', '/taxi/request', {
      token: pa,
      body: { pickup: 'A', destination: 'B', pickupLat: 999, pickupLng: 999 },
    })
  );
  await rec(
    'create:noauth',
    call(base, 'POST', '/taxi/request', { body: { pickup: 'A', destination: 'B' } })
  );
  // Create a real trip (no coords → no matching side-effects that differ)
  const created = await call(base, 'POST', '/taxi/request', {
    token: pa,
    body: { pickup: 'Salmiya', destination: 'Kuwait City', payment_method: 'cash' },
  });
  await rec('create:ok', Promise.resolve(created));
  const tripId = created.body?.trip?.id;
  // Get trip (owner / stranger / driver)
  await rec('get:owner', call(base, 'GET', `/taxi/trips/${tripId}`, { token: pa }));
  await rec('get:stranger', call(base, 'GET', `/taxi/trips/${tripId}`, { token: pb }));
  await rec('get:missing', call(base, 'GET', '/taxi/trips/999999', { token: pa }));
  await rec('get:location', call(base, 'GET', `/taxi/trips/${tripId}/location`, { token: pa }));
  // Status transitions
  await rec(
    'status:invalid',
    call(base, 'PUT', `/taxi/trips/${tripId}/status`, { token: drv, body: { status: 'flying' } })
  );
  await rec(
    'status:accept:bypassenger',
    call(base, 'PUT', `/taxi/trips/${tripId}/status`, { token: pa, body: { status: 'accepted' } })
  );
  await rec(
    'status:accept',
    call(base, 'PUT', `/taxi/trips/${tripId}/status`, { token: drv, body: { status: 'accepted' } })
  );
  await rec(
    'status:arrived',
    call(base, 'PUT', `/taxi/trips/${tripId}/status`, { token: drv, body: { status: 'arrived' } })
  );
  await rec(
    'status:inprogress',
    call(base, 'PUT', `/taxi/trips/${tripId}/status`, {
      token: drv,
      body: { status: 'in_progress' },
    })
  );
  await rec(
    'location:update',
    call(base, 'POST', '/taxi/update-location', {
      token: drv,
      body: { tripId, lat: 29.34, lng: 47.98 },
    })
  );
  await rec(
    'status:completed',
    call(base, 'PUT', `/taxi/trips/${tripId}/status`, { token: drv, body: { status: 'completed' } })
  );
  // Ratings
  await rec(
    'rate:notcompleted-range',
    call(base, 'POST', `/taxi/trips/${tripId}/rate`, { token: pa, body: { rating: 9 } })
  );
  await rec(
    'rate:ok',
    call(base, 'POST', `/taxi/trips/${tripId}/rate`, {
      token: pa,
      body: { rating: 5, comment: 'great' },
    })
  );
  await rec(
    'rate:duplicate',
    call(base, 'POST', `/taxi/trips/${tripId}/rate`, { token: pa, body: { rating: 4 } })
  );
  await rec(
    'rate:stranger',
    call(base, 'POST', `/taxi/trips/${tripId}/rate`, { token: pb, body: { rating: 5 } })
  );
  await rec(
    'ratepassenger:ok',
    call(base, 'POST', `/taxi/trips/${tripId}/rate-passenger`, { token: drv, body: { rating: 5 } })
  );
  // Cancel a completed trip → not cancellable
  await rec(
    'cancel:completed',
    call(base, 'PUT', `/taxi/trips/${tripId}/status`, { token: pa, body: { status: 'cancelled' } })
  );
  // Second trip → passenger cancels while waiting
  const t2 = (
    await call(base, 'POST', '/taxi/request', {
      token: pb,
      body: { pickup: 'X', destination: 'Y' },
    })
  ).body?.trip?.id;
  await rec(
    'cancel:waiting',
    call(base, 'PUT', `/taxi/trips/${t2}/status`, { token: pb, body: { status: 'cancelled' } })
  );
  await rec('reject:invalid', call(base, 'POST', `/taxi/trips/${t2}/reject`, { token: drv }));
  // Admin delete all
  await rec('deleteall:noauth', call(base, 'DELETE', '/taxi/trips', { token: pa }));
  await rec('deleteall:ok', call(base, 'DELETE', '/taxi/trips', { token: admin }));
  // Places proxy (no API key → deterministic empty)
  await rec('places:auto', call(base, 'GET', '/places/autocomplete?input=sal', { token: pa }));
  await rec('places:details', call(base, 'GET', '/places/details?place_id=x', { token: pa }));
  return out;
}

const stable = (v) => JSON.stringify(normalize(v));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'trips-ab-'));
  let legacy,
    next,
    fails = 0,
    total = 0;
  try {
    legacy = await startServer({ legacy: true, port: 4921, dbPath: join(dir, 'legacy.db') });
    next = await startServer({ legacy: false, port: 4922, dbPath: join(dir, 'new.db') });
    const a = await runScenarios(legacy.base);
    const b = await runScenarios(next.base);
    console.log(`\n  Trips A/B compatibility — ${a.length} scenarios\n  ${'-'.repeat(52)}`);
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
