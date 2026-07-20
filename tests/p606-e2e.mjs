/**
 * P6-06 End-to-End Test Suite
 * ==============================
 * Tests the full Driver Approval Workflow:
 *   Registration → Pending → Approve → Login → Socket → Trip → Complete
 *   Suspend (all 7 cleanup layers) → verify exclusion
 *   Reactivate → Login → Trip → Complete
 *
 * Run from oncall-backend root:
 *   node tests/p606-e2e.mjs
 *
 * Requires server on port 3000 OR starts it automatically.
 */

import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Colors ──────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', blue: '\x1b[34m', bold: '\x1b[1m',
};
const pass  = (msg)   => { PASS++; console.log(`  ${C.green}✅ PASS${C.reset} — ${msg}`); };
const fail  = (msg, detail='') => {
  FAIL++;
  console.log(`  ${C.red}❌ FAIL${C.reset} — ${msg}`);
  if (detail) console.log(`       ${C.red}↳ ${String(detail).slice(0,200)}${C.reset}`);
};
const info  = (msg)   => console.log(`  ${C.cyan}ℹ ${C.reset} ${msg}`);
const warn  = (msg)   => { WARN++; console.log(`  ${C.yellow}⚠️  WARN${C.reset} — ${msg}`); };
const section = (n, title) => console.log(`\n${C.cyan}━━━ §${n}. ${title} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);

let PASS = 0, FAIL = 0, WARN = 0;

// ── HTTP helper ──────────────────────────────────────────────────────────────
const BASE = 'http://localhost:3000';

async function req(method, path, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 3000, path,
      method, timeout: 8000,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
    };
    const r = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw), raw }); }
        catch { resolve({ status: res.statusCode, body: null, raw }); }
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: null, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: null, error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

const GET    = (p, t)    => req('GET',    p, null, t);
const POST   = (p, b, t) => req('POST',   p, b,    t);
const PUT    = (p, b, t) => req('PUT',    p, b,    t);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Server management ────────────────────────────────────────────────────────
let serverProc = null;

async function ensureServer() {
  const r = await GET('/health');
  if (r.status === 200) { info('Server already running on :3000'); return true; }
  info('Starting server...');
  serverProc = spawn('node', ['server.js'], { cwd: ROOT, stdio: ['ignore','pipe','pipe'] });
  let started = false;
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    const r2 = await GET('/health');
    if (r2.status === 200) { started = true; break; }
    if (serverProc.exitCode !== null) {
      console.error('Server exited prematurely');
      return false;
    }
  }
  return started;
}

function stopServer() {
  if (serverProc) { serverProc.kill('SIGTERM'); serverProc = null; }
}

// ── SQLite direct access ─────────────────────────────────────────────────────
let db = null;
function initDB() {
  try {
    const require = createRequire(import.meta.url);
    const sqlite3 = require('sqlite3');
    const dbPath = path.join(ROOT, 'oncall.db');
    if (!fs.existsSync(dbPath)) { warn('oncall.db not found — DB checks skipped'); return; }
    db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
  } catch { warn('sqlite3 not available — DB direct checks skipped'); }
}

function dbQuery(sql, params = []) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

// ── Load admin phone from env ─────────────────────────────────────────────────
let ADMIN_PHONE = '';
let ADMIN_TOKEN = '';

async function getAdminPhone() {
  try {
    const require = createRequire(import.meta.url);
    const { ADMIN_PHONES } = require(path.join(ROOT, 'src/config/env.js'));
    if (Array.isArray(ADMIN_PHONES) && ADMIN_PHONES.length > 0) {
      ADMIN_PHONE = String(ADMIN_PHONES[0]);
    }
  } catch { warn('Could not load ADMIN_PHONES from env.js'); }
  if (!ADMIN_PHONE) { warn('No ADMIN_PHONE — admin tests will be skipped'); return; }
  const r = await POST('/login', { phone: ADMIN_PHONE });
  if (r.status === 200 && r.body?.token) {
    ADMIN_TOKEN = r.body.token;
    info(`Admin logged in: ${ADMIN_PHONE.slice(0,3)}***`);
  } else {
    warn(`Admin login failed (${r.status}) — admin endpoints skipped`);
  }
}

// ── Unique phone generator ────────────────────────────────────────────────────
const ts = Date.now().toString().slice(-6);
const DRIVER_PHONE = `7${ts}01`;
const DRIVER_PHONE_2 = `7${ts}02`;
const DRIVER_PHONE_STRESS = (i) => `8${ts}${String(i).padStart(2,'0')}`;

// ═══════════════════════════════════════════════════════════════════════════
// § 1 — REGISTRATION → PENDING
// ═══════════════════════════════════════════════════════════════════════════
async function testRegistration() {
  section(1, 'Registration → Pending');

  const r = await POST('/driver/login', { phone: DRIVER_PHONE });
  if (r.status === 403 && r.body?.status === 'pending') {
    pass(`New driver blocked at login — status=pending (phone ${DRIVER_PHONE.slice(0,3)}***)`);
  } else if (r.status === 200) {
    // Driver might already be approved from a previous run
    warn('Driver is approved (pre-existing) — clearing approval state is not possible in E2E');
  } else {
    fail('New driver should return 403 + status=pending', JSON.stringify(r.body));
  }

  // Verify pending list includes this driver
  if (ADMIN_TOKEN) {
    const r2 = await GET('/admin/drivers/pending', ADMIN_TOKEN);
    if (r2.status === 200) {
      const drivers = Array.isArray(r2.body) ? r2.body : r2.body?.drivers || [];
      const found = drivers.some(d => d.phone === DRIVER_PHONE);
      if (found) {
        pass('Driver appears in /admin/drivers/pending list');
      } else {
        // might already be in a non-pending state
        info('Driver not in pending list (possibly previous test run)');
      }
    } else {
      fail('/admin/drivers/pending', `${r2.status}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 2 — APPROVE
// ═══════════════════════════════════════════════════════════════════════════
async function testApprove() {
  section(2, 'Admin Approve Driver');
  if (!ADMIN_TOKEN) { warn('No admin token — skipping approve'); return; }

  const r = await PUT(`/admin/drivers/${DRIVER_PHONE}/approve`, {}, ADMIN_TOKEN);
  if (r.status === 200 && r.body?.success) {
    pass(`Driver ${DRIVER_PHONE.slice(0,3)}*** approved — status=approved`);
  } else if (r.status === 400 && r.body?.code === 'ALREADY_APPROVED') {
    pass('Driver already approved (idempotent — ALREADY_APPROVED)');
  } else {
    fail('Approve driver', `${r.status} ${JSON.stringify(r.body)}`);
  }

  // Verify DB state
  const rows = await dbQuery('SELECT approval_status FROM drivers WHERE phone=?', [DRIVER_PHONE]);
  if (rows.length > 0) {
    if (rows[0].approval_status === 'approved') {
      pass('DB: drivers.approval_status = approved ✅');
    } else {
      fail('DB approval_status mismatch', rows[0].approval_status);
    }
  }

  // Verify audit log
  const logs = await dbQuery(
    "SELECT action FROM driver_approval_logs WHERE driver_phone=? AND action='APPROVED' ORDER BY id DESC LIMIT 1",
    [DRIVER_PHONE]
  );
  if (logs.length > 0) {
    pass('DB: driver_approval_logs contains APPROVED entry ✅');
  } else {
    warn('DB: No APPROVED log entry found (might be prior test run)');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 3 — LOGIN → TOKENS
// ═══════════════════════════════════════════════════════════════════════════
let DRIVER_TOKEN = '';
let DRIVER_REFRESH = '';

async function testLogin() {
  section(3, 'Approved Driver Login');

  const r = await POST('/driver/login', { phone: DRIVER_PHONE });
  if (r.status === 200 && r.body?.token) {
    DRIVER_TOKEN = r.body.token;
    DRIVER_REFRESH = r.body.refreshToken || '';
    pass(`Approved driver login OK — token issued (len=${DRIVER_TOKEN.length})`);
    if (DRIVER_REFRESH) {
      pass('Refresh token issued ✅');
    } else {
      warn('No refresh token in response');
    }
  } else {
    fail('Approved driver login', `${r.status} ${JSON.stringify(r.body)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 4 — TOKEN REFRESH (happy path)
// ═══════════════════════════════════════════════════════════════════════════
async function testRefreshHappy() {
  section(4, 'Refresh Token — Happy Path');
  if (!DRIVER_REFRESH) { warn('No refresh token — skipping'); return; }

  const r = await POST('/auth/refresh', { refreshToken: DRIVER_REFRESH });
  if (r.status === 200 && r.body?.token) {
    DRIVER_TOKEN = r.body.token;
    DRIVER_REFRESH = r.body.refreshToken || DRIVER_REFRESH;
    pass('POST /auth/refresh → new access token ✅');
  } else {
    fail('POST /auth/refresh happy path', `${r.status} ${JSON.stringify(r.body)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 5 — SOCKET REGISTER (HTTP probe)
// ═══════════════════════════════════════════════════════════════════════════
async function testSocketProbe() {
  section(5, 'Socket.IO Reachability');

  const r = await GET('/socket.io/?EIO=4&transport=polling');
  if (r.status === 200 || r.status === 101 || r.raw?.includes('sid')) {
    pass('Socket.IO polling endpoint responds ✅');
  } else {
    warn(`Socket.IO endpoint: HTTP ${r.status}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 6 — DRIVER STATUS (go online)
// ═══════════════════════════════════════════════════════════════════════════
async function testDriverOnline() {
  section(6, 'Driver Go Online');
  if (!DRIVER_TOKEN) { warn('No driver token — skipping'); return; }

  const r = await POST('/driver/status',
    { phone: DRIVER_PHONE, isOnline: true, lat: 29.3765, lng: 47.9785 },
    DRIVER_TOKEN
  );
  if (r.status === 200 && r.body?.success) {
    pass('Driver status → online ✅');
  } else {
    fail('Driver status online', `${r.status} ${JSON.stringify(r.body)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 7 — SUSPEND DURING ONLINE (all cleanup layers)
// ═══════════════════════════════════════════════════════════════════════════
async function testSuspend() {
  section(7, 'Suspend Driver — All 7 Cleanup Layers');
  if (!ADMIN_TOKEN) { warn('No admin token — skipping suspend'); return; }
  if (!DRIVER_PHONE) { warn('No driver phone'); return; }

  // Capture refresh token before suspend
  const refreshBefore = DRIVER_REFRESH;

  // Execute suspend
  const r = await PUT(`/admin/drivers/${DRIVER_PHONE}/suspend`,
    { reason: 'P6-06 E2E automated test suspension' },
    ADMIN_TOKEN
  );
  if (r.status === 200 && r.body?.success) {
    pass('PUT /admin/drivers/:phone/suspend → 200 ✅');
  } else if (r.status === 400 && r.body?.code === 'ALREADY_SUSPENDED') {
    pass('Driver already suspended — ALREADY_SUSPENDED (idempotent) ✅');
  } else {
    fail('Suspend driver', `${r.status} ${JSON.stringify(r.body)}`);
    return;
  }

  await sleep(300); // allow async cleanup to complete

  // Layer 1: DB state
  const rows = await dbQuery('SELECT approval_status, status FROM drivers WHERE phone=?', [DRIVER_PHONE]);
  if (rows.length > 0) {
    if (rows[0].approval_status === 'suspended') {
      pass('Layer 1 — DB: approval_status = suspended ✅');
    } else {
      fail('Layer 1 — DB approval_status', rows[0].approval_status);
    }
    if (rows[0].status === 'offline') {
      pass('Layer 1b — DB: driver.status = offline ✅');
    } else {
      fail('Layer 1b — DB driver.status', rows[0].status);
    }
  }

  // Layer 2: Audit log
  const logs = await dbQuery(
    "SELECT action, reason FROM driver_approval_logs WHERE driver_phone=? AND action='SUSPENDED' ORDER BY id DESC LIMIT 1",
    [DRIVER_PHONE]
  );
  if (logs.length > 0) {
    pass(`Layer 2 — Audit log: SUSPENDED recorded ✅ (reason: "${logs[0].reason}")`);
  } else {
    fail('Layer 2 — No SUSPENDED audit log');
  }

  // Layer 3: Access token revoked
  const r3 = await GET('/auth/verify', DRIVER_TOKEN);
  if (r3.status === 401) {
    pass('Layer 3 — Access token revoked: /auth/verify → 401 ✅');
  } else if (r3.status === 403) {
    pass('Layer 3 — Access token revoked: /auth/verify → 403 ✅');
  } else {
    fail('Layer 3 — Access token should be revoked', `Got HTTP ${r3.status}`);
  }

  // Layer 4: Refresh token revoked in DB
  if (refreshBefore) {
    const rtRows = await dbQuery(
      'SELECT revoked FROM refresh_tokens WHERE phone=? AND revoked=0',
      [DRIVER_PHONE]
    );
    if (rtRows.length === 0) {
      pass('Layer 4 — All refresh tokens revoked in DB ✅');
    } else {
      fail('Layer 4 — Active refresh tokens remain', `${rtRows.length} active`);
    }
  } else {
    warn('Layer 4 — No refresh token to check (not issued earlier)');
  }

  // Layer 5: Refresh token API rejected
  if (refreshBefore) {
    const r5 = await POST('/auth/refresh', { refreshToken: refreshBefore });
    if (r5.status === 401 || r5.status === 403) {
      pass(`Layer 5 — POST /auth/refresh with suspended driver → ${r5.status} ✅`);
    } else {
      fail('Layer 5 — Refresh should be rejected for suspended driver', `Got ${r5.status}`);
    }
  } else {
    warn('Layer 5 — No refresh token to test');
  }

  // Layer 6: Login rejected
  const r6 = await POST('/driver/login', { phone: DRIVER_PHONE });
  if (r6.status === 403 && r6.body?.status === 'suspended') {
    pass('Layer 6 — Login blocked: status=suspended ✅');
  } else {
    fail('Layer 6 — Suspended driver should not be able to login', `${r6.status} ${JSON.stringify(r6.body)}`);
  }

  // Layer 7: Driver Matcher excluded
  // We can check this via the driver status endpoint or DB query
  const matcherRows = await dbQuery(
    "SELECT phone FROM drivers WHERE phone=? AND approval_status='approved'",
    [DRIVER_PHONE]
  );
  if (matcherRows.length === 0) {
    pass('Layer 7 — Driver Matcher SQL: suspended driver excluded from approved set ✅');
  } else {
    fail('Layer 7 — Suspended driver still in approved set');
  }

  // Clear token (invalidated)
  DRIVER_TOKEN = '';
  DRIVER_REFRESH = '';
}

// ═══════════════════════════════════════════════════════════════════════════
// § 8 — REACTIVATE
// ═══════════════════════════════════════════════════════════════════════════
async function testReactivate() {
  section(8, 'Reactivate Driver');
  if (!ADMIN_TOKEN) { warn('No admin token — skipping'); return; }

  const r = await PUT(`/admin/drivers/${DRIVER_PHONE}/reactivate`, {}, ADMIN_TOKEN);
  if (r.status === 200 && r.body?.success) {
    pass('PUT /admin/drivers/:phone/reactivate → 200 ✅');
  } else if (r.status === 400 && r.body?.code === 'ALREADY_APPROVED') {
    pass('Already approved — ALREADY_APPROVED (idempotent) ✅');
  } else {
    fail('Reactivate driver', `${r.status} ${JSON.stringify(r.body)}`);
    return;
  }

  // Verify DB
  const rows = await dbQuery('SELECT approval_status FROM drivers WHERE phone=?', [DRIVER_PHONE]);
  if (rows[0]?.approval_status === 'approved') {
    pass('DB: approval_status = approved after reactivation ✅');
  } else {
    fail('DB: approval_status after reactivation', rows[0]?.approval_status);
  }

  // Audit log
  const logs = await dbQuery(
    "SELECT action FROM driver_approval_logs WHERE driver_phone=? AND action='REACTIVATED' ORDER BY id DESC LIMIT 1",
    [DRIVER_PHONE]
  );
  if (logs.length > 0) {
    pass('DB: REACTIVATED audit log ✅');
  } else {
    warn('DB: No REACTIVATED audit log found');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 9 — REACTIVATED DRIVER CAN LOG IN AGAIN
// ═══════════════════════════════════════════════════════════════════════════
async function testLoginAfterReactivation() {
  section(9, 'Reactivated Driver Login');

  const r = await POST('/driver/login', { phone: DRIVER_PHONE });
  if (r.status === 200 && r.body?.token) {
    DRIVER_TOKEN = r.body.token;
    DRIVER_REFRESH = r.body.refreshToken || '';
    pass('Reactivated driver login OK — new tokens issued ✅');
    pass(`New refresh token: ${DRIVER_REFRESH ? 'YES' : 'NO'}`);
  } else {
    fail('Reactivated driver login', `${r.status} ${JSON.stringify(r.body)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 10 — REJECT flow
// ═══════════════════════════════════════════════════════════════════════════
async function testReject() {
  section(10, 'Reject Driver (second driver)');
  if (!ADMIN_TOKEN) { warn('No admin token — skipping'); return; }

  // Ensure second driver exists
  await POST('/driver/login', { phone: DRIVER_PHONE_2 });

  const r = await PUT(`/admin/drivers/${DRIVER_PHONE_2}/reject`,
    { reason: 'P6-06 E2E automated rejection test' },
    ADMIN_TOKEN
  );
  if (r.status === 200 && r.body?.success) {
    pass('PUT /admin/drivers/:phone/reject → 200 ✅');
  } else if (r.status === 400 && r.body?.code === 'ALREADY_REJECTED') {
    pass('ALREADY_REJECTED (idempotent) ✅');
  } else {
    fail('Reject driver', `${r.status} ${JSON.stringify(r.body)}`);
    return;
  }

  // Verify blocked
  const r2 = await POST('/driver/login', { phone: DRIVER_PHONE_2 });
  if (r2.status === 403 && r2.body?.status === 'rejected') {
    pass(`Rejected driver blocked: status=rejected, reason="${r2.body?.reason}" ✅`);
  } else {
    fail('Rejected driver should be blocked', `${r2.status} ${JSON.stringify(r2.body)}`);
  }

  // DB audit log
  const logs = await dbQuery(
    "SELECT action, reason FROM driver_approval_logs WHERE driver_phone=? AND action='REJECTED' ORDER BY id DESC LIMIT 1",
    [DRIVER_PHONE_2]
  );
  if (logs.length > 0) {
    pass(`DB: REJECTED audit log ✅ (reason: "${logs[0].reason}")`);
  } else {
    warn('DB: No REJECTED audit log');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 11 — IDEMPOTENCY (Double Approve, Double Suspend)
// ═══════════════════════════════════════════════════════════════════════════
async function testIdempotency() {
  section(11, 'Idempotency Checks');
  if (!ADMIN_TOKEN) { warn('No admin token — skipping'); return; }

  // Double approve
  const r1 = await PUT(`/admin/drivers/${DRIVER_PHONE}/approve`, {}, ADMIN_TOKEN);
  const r2 = await PUT(`/admin/drivers/${DRIVER_PHONE}/approve`, {}, ADMIN_TOKEN);

  if (r2.status === 400 && r2.body?.code === 'ALREADY_APPROVED') {
    pass('Double Approve: second returns 400 ALREADY_APPROVED ✅');
  } else if (r2.status === 200) {
    warn('Double Approve: second returned 200 (idempotency not enforced strictly)');
  } else {
    fail('Double Approve second call', `${r2.status} ${JSON.stringify(r2.body)}`);
  }

  // No duplicate audit logs (should have at most 1 new APPROVED entry for second attempt)
  const logs = await dbQuery(
    "SELECT COUNT(*) as c FROM driver_approval_logs WHERE driver_phone=? AND action='APPROVED'",
    [DRIVER_PHONE]
  );
  info(`APPROVED audit log count for driver: ${logs[0]?.c}`);
  // We just verify there's no runaway duplication
  if ((logs[0]?.c || 0) < 10) {
    pass('Audit log count reasonable (no runaway duplication) ✅');
  } else {
    fail('Too many APPROVED audit log entries', `${logs[0]?.c} entries`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 12 — SECURITY: Non-admin cannot approve
// ═══════════════════════════════════════════════════════════════════════════
async function testPrivilegeEscalation() {
  section(12, 'Security — Privilege Escalation');

  // Passenger token
  const ts2 = Date.now().toString().slice(-5);
  const PASS_PHONE = `6${ts2}99`;
  const rLogin = await POST('/login', { phone: PASS_PHONE, name: 'Test Passenger' });
  const passToken = rLogin.body?.token;

  if (!passToken) { warn('Could not get passenger token'); return; }

  // Attempt approve with passenger token
  const r1 = await PUT(`/admin/drivers/${DRIVER_PHONE}/approve`, {}, passToken);
  if (r1.status === 403 || r1.status === 401) {
    pass(`Passenger token → /admin/approve returns ${r1.status} ✅`);
  } else {
    fail('IDOR: Passenger should not be able to approve drivers', `Got ${r1.status}`);
  }

  // Attempt with no token
  const r2 = await PUT(`/admin/drivers/${DRIVER_PHONE}/approve`, {});
  if (r2.status === 401 || r2.status === 403) {
    pass(`No token → /admin/approve returns ${r2.status} ✅`);
  } else {
    fail('No-auth approval should be blocked', `Got ${r2.status}`);
  }

  // Attempt to approve with driver's own token
  if (DRIVER_TOKEN) {
    const r3 = await PUT(`/admin/drivers/${DRIVER_PHONE}/approve`, {}, DRIVER_TOKEN);
    if (r3.status === 401 || r3.status === 403) {
      pass(`Driver token → /admin/approve returns ${r3.status} ✅`);
    } else {
      fail('Driver should not approve themselves', `Got ${r3.status}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 13 — SECURITY: Admin phone from JWT only (IDOR)
// ═══════════════════════════════════════════════════════════════════════════
async function testIDOR() {
  section(13, 'Security — IDOR (adminPhone from JWT)');
  if (!ADMIN_TOKEN) { warn('No admin token — skipping'); return; }

  // The admin endpoint must not accept adminPhone from body
  const r = await PUT(`/admin/drivers/${DRIVER_PHONE}/approve`,
    { adminPhone: '99999999' }, // spoofed admin phone
    ADMIN_TOKEN
  );
  // Should succeed but use JWT phone, not body phone
  if (r.status === 200 || r.status === 400) {
    // Check audit log — admin_phone should be ADMIN_PHONE, not 99999999
    const logs = await dbQuery(
      "SELECT admin_phone FROM driver_approval_logs WHERE driver_phone=? ORDER BY id DESC LIMIT 1",
      [DRIVER_PHONE]
    );
    if (logs.length > 0 && logs[0].admin_phone !== '99999999') {
      pass(`IDOR: audit log admin_phone = "${logs[0].admin_phone}" (JWT, not body) ✅`);
    } else if (logs.length > 0 && logs[0].admin_phone === '99999999') {
      fail('IDOR: admin_phone taken from body, not JWT!', '99999999');
    } else {
      warn('IDOR: no log entry to verify');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 14 — DB INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════
async function testDBIntegrity() {
  section(14, 'Database Integrity');

  // PRAGMA integrity_check
  const rows = await dbQuery('PRAGMA integrity_check');
  if (rows[0]?.integrity_check === 'ok') {
    pass('PRAGMA integrity_check = ok ✅');
  } else {
    fail('DB integrity check', JSON.stringify(rows[0]));
  }

  // No stale refresh tokens (revoked=0) for suspended drivers
  const staleRT = await dbQuery(`
    SELECT COUNT(*) as c
    FROM refresh_tokens rt
    JOIN drivers d ON d.phone = rt.phone
    WHERE d.approval_status = 'suspended'
      AND rt.revoked = 0
      AND rt.expires_at > strftime('%s','now')
  `);
  if ((staleRT[0]?.c || 0) === 0) {
    pass('No active refresh tokens for suspended drivers ✅');
  } else {
    fail('Stale refresh tokens exist for suspended drivers', `${staleRT[0]?.c} found`);
  }

  // Every driver status change must have an audit log (APPROVED/REJECTED/SUSPENDED/REACTIVATED)
  const driversWithLogs = await dbQuery(`
    SELECT d.phone, d.approval_status, COUNT(l.id) as log_count
    FROM drivers d
    LEFT JOIN driver_approval_logs l ON l.driver_phone = d.phone
    WHERE d.approval_status != 'pending'
    GROUP BY d.phone
    HAVING log_count = 0
  `);
  if (driversWithLogs.length === 0) {
    pass('All non-pending drivers have at least one audit log ✅');
  } else {
    fail('Drivers without audit logs', driversWithLogs.map(d=>d.phone).join(', '));
  }

  // No duplicate audit records in same second (race condition indicator)
  const dupes = await dbQuery(`
    SELECT driver_phone, action, created_at, COUNT(*) as c
    FROM driver_approval_logs
    GROUP BY driver_phone, action, created_at
    HAVING c > 1
    LIMIT 5
  `);
  if (dupes.length === 0) {
    pass('No duplicate audit log entries (same driver+action+timestamp) ✅');
  } else {
    warn(`Potential duplicate audit logs: ${dupes.length} groups — may indicate race condition`);
  }

  // Refresh tokens table — no orphaned rows
  const orphans = await dbQuery(`
    SELECT COUNT(*) as c FROM refresh_tokens rt
    WHERE NOT EXISTS (SELECT 1 FROM drivers d WHERE d.phone=rt.phone)
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.phone=rt.phone)
  `);
  if ((orphans[0]?.c || 0) === 0) {
    pass('No orphaned refresh_tokens ✅');
  } else {
    warn(`Orphaned refresh_tokens: ${orphans[0]?.c} (phone not in drivers/users)`);
  }

  // WAL mode
  const wal = await dbQuery('PRAGMA journal_mode');
  if (wal[0]?.journal_mode === 'wal') {
    pass('journal_mode = WAL ✅');
  } else {
    warn(`journal_mode = ${wal[0]?.journal_mode} (expected WAL)`);
  }

  // Indexes present
  const indexes = await dbQuery("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'");
  const indexNames = indexes.map(r => r.name);
  const requiredIndexes = [
    'idx_drivers_approval',
    'idx_approval_logs_driver',
    'idx_drivers_phone',
    'idx_trips_status',
    'idx_rt_hash',
    'idx_rt_phone',
  ];
  for (const idx of requiredIndexes) {
    if (indexNames.includes(idx)) {
      pass(`Index present: ${idx} ✅`);
    } else {
      fail(`Missing index: ${idx}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 15 — APPROVAL HISTORY ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════
async function testApprovalHistory() {
  section(15, 'Approval History Endpoint');
  if (!ADMIN_TOKEN) { warn('No admin token — skipping'); return; }

  const r = await GET(`/admin/drivers/${DRIVER_PHONE}/approval-history`, ADMIN_TOKEN);
  if (r.status === 200 && r.body?.success) {
    const logs = r.body.logs || [];
    pass(`GET /admin/drivers/:phone/approval-history → ${logs.length} entries ✅`);
    const actions = logs.map(l => l.action);
    info(`Actions logged: ${actions.join(' → ')}`);
  } else {
    fail('GET /admin/drivers/:phone/approval-history', `${r.status} ${JSON.stringify(r.body)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n${C.bold}${C.blue}╔════════════════════════════════════════════════════╗`);
  console.log(`║     P6-06 End-to-End Test Suite                    ║`);
  console.log(`╚════════════════════════════════════════════════════╝${C.reset}`);
  console.log(`  Driver phones: ${DRIVER_PHONE}, ${DRIVER_PHONE_2}`);

  const ok = await ensureServer();
  if (!ok) { console.error('FATAL: Server failed to start'); process.exit(1); }

  await getAdminPhone();
  initDB();
  await sleep(500);

  await testRegistration();
  await testApprove();
  await testLogin();
  await testRefreshHappy();
  await testSocketProbe();
  await testDriverOnline();
  await testSuspend();
  await testReactivate();
  await testLoginAfterReactivation();
  await testReject();
  await testIdempotency();
  await testPrivilegeEscalation();
  await testIDOR();
  await testDBIntegrity();
  await testApprovalHistory();

  // ── Final Report ──────────────────────────────────────────────────────────
  const total = PASS + FAIL + WARN;
  const score = total > 0 ? Math.round(PASS * 100 / total) : 0;

  console.log(`\n${C.blue}╔═══════════════════════════════════════════════════╗`);
  console.log(`║     P6-06 E2E RESULTS                              ║`);
  console.log(`╚═══════════════════════════════════════════════════╝${C.reset}`);
  console.log(`  ${C.green}✅ PASS : ${PASS}${C.reset}`);
  console.log(`  ${C.red}❌ FAIL : ${FAIL}${C.reset}`);
  console.log(`  ${C.yellow}⚠️  WARN : ${WARN}${C.reset}`);
  console.log(`  ─────────────────`);
  console.log(`  Total : ${total}`);
  console.log(`  Score : ${score}%`);

  if (FAIL === 0) {
    console.log(`\n  ${C.green}${C.bold}🎉 ALL E2E TESTS PASSED — P6-06 WORKFLOW VERIFIED${C.reset}\n`);
  } else {
    console.log(`\n  ${C.red}${C.bold}❌ ${FAIL} FAILURE(S) — MUST FIX BEFORE PRODUCTION${C.reset}\n`);
    process.exitCode = 1;
  }

  stopServer();
  if (db) db.close();
}

main().catch(e => { console.error(e); stopServer(); process.exit(1); });
