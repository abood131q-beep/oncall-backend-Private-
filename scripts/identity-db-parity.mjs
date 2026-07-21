#!/usr/bin/env node
/**
 * identity-db-parity.mjs — Phase 20.b-cont (ADR-047 Gate B2: refresh/revocation/repository parity).
 *
 * Closes the shadow's DB coverage gap: instead of leaving the `refresh`/`repository` categories
 * DECLARED-BUT-UNEXERCISED (which reported a misleading 100% on zero comparisons), this drives REAL
 * legacy-vs-kernel comparisons against a real sqlite DB:
 *   • refresh-token verify (valid / rotated / revoked / invalid / null),
 *   • access-token revocation (revoke → both verifiers reject),
 *   • repository reads (user/driver by phone, present + missing).
 * The kernel path goes through the consolidated Identity Kernel's infrastructure ports (token +
 * repository pass-through) — so this proves the SEAM is faithful end-to-end on the DB surface.
 *
 * Runs anywhere via the dev sqlite3-compat preload:
 *   node -r ./tools/dev/sqlite3-compat.js scripts/identity-db-parity.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const tmp = mkdtempSync(join(tmpdir(), 'id-db-parity-'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'id-db-parity-secret';
process.env.DB_PATH = join(tmp, 'oncall.db');
process.env.NODE_ENV = 'development';

const db = require(join(ROOT, 'src/config/database'));
const { runMigrations } = require(join(ROOT, 'src/config/migrate'));
const auth = require(join(ROOT, 'src/middleware/auth'));
const { createUserRepository } = require(join(ROOT, 'src/repositories/UserRepository'));
const { createDriverRepository } = require(join(ROOT, 'src/repositories/DriverRepository'));
const { attachIdentityShadow } = require(join(ROOT, 'src/enterprise/identityShadow'));

let failures = 0;
const line = (ok, msg) => {
  console.log(`  ${ok ? '✅' : '❌'} ${msg}`);
  if (!ok) failures++;
};

try {
  const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };
  await runMigrations(db.dbRun, quiet); // adds columns + creates auth tables (same as app boot)
  await auth.initRevocationStore(db.dbRun, db.dbAll);

  const userRepo = createUserRepository({ dbGet: db.dbGet, dbAll: db.dbAll, dbRun: db.dbRun });
  const driverRepo = createDriverRepository({ dbGet: db.dbGet, dbAll: db.dbAll, dbRun: db.dbRun });

  const userPhone = '90000001';
  const driverPhone = '90000002';
  await userRepo.create(userPhone, 'DB Parity User');
  await driverRepo.create(driverPhone);

  // Issue refresh tokens through the certified legacy primitive (bound to the real DB).
  const rawUser = await auth.generateRefreshToken({ phone: userPhone, type: 'passenger', role: 'passenger', name: 'U' }, db.dbRun);
  const rawDriver = await auth.generateRefreshToken({ phone: driverPhone, type: 'driver', role: 'driver', driverId: 1, name: 'D' }, db.dbRun);
  const rawRevoked = await auth.generateRefreshToken({ phone: userPhone, type: 'passenger', role: 'passenger' }, db.dbRun);
  await auth.revokeRefreshToken(rawRevoked, db.dbRun); // revoke one to exercise the revoked path

  // Bind DB primitives + repos into the shadow (legacy + kernel both use these; real comparison).
  const primitives = {
    generateJWT: auth.generateJWT,
    verifyJWT: auth.verifyJWT,
    verifyRefreshToken: (t) => auth.verifyRefreshToken(t, db.dbGet),
    findUserByPhone: (p) => userRepo.findByPhone(p),
    findDriverByPhone: (p) => driverRepo.findByPhone(p),
    adminPhones: [],
    requireOtp: false,
  };
  const shadow = attachIdentityShadow({ platformIdentity: true, shadowIdentity: true, primitives, logger: quiet });

  // Drive REAL refresh + repository comparisons.
  const rep = await shadow.verifyDbSurface({
    refreshTokens: [rawUser, rawDriver, rawRevoked, 'invalid-token', null],
    userPhones: [userPhone, '99999999'],
    driverPhones: [driverPhone, '99999999'],
  });

  // Access-token revocation parity through the kernel seam: issue → verify (match) → revoke via
  // the shared revocation store → verify (both reject). Exercises the revocation decision path.
  const jwt = auth.generateJWT({ phone: userPhone, type: 'passenger', role: 'passenger' });
  const beforeRevoke = shadow.shadowVerify(jwt, { requestId: 'atr-before' }); // legacy value; both compared
  auth.revokeTokens(userPhone); // in-memory + DB revocation (shared by legacy + kernel verify)
  const afterRevoke = shadow.shadowVerify(jwt, { requestId: 'atr-after' });
  const rep2 = shadow.report();
  line(beforeRevoke != null, 'access token valid BEFORE revoke');
  line(afterRevoke === null, 'access token rejected AFTER revoke (both verifiers agree)');
  line(rep2.jwtParityPct === 100, `jwt parity incl. revocation ${rep2.jwtParityPct}%`);

  line((rep.categories.refresh.comparisons || 0) > 0, `refresh comparisons ran = ${rep.categories.refresh.comparisons}`);
  line((rep.categories.repository.comparisons || 0) > 0, `repository comparisons ran = ${rep.categories.repository.comparisons}`);
  line(rep.refreshParityPct === 100, `refresh parity ${rep.refreshParityPct}%`);
  line(rep.repositoryParityPct === 100, `repository parity ${rep.repositoryParityPct}%`);
  line(rep.mismatches === 0, `mismatches ${rep.mismatches}`);
  line(rep.verificationFailures === 0, `verificationFailures ${rep.verificationFailures}`);

  const finalRep = shadow.report();
  const evidence = {
    phase: '20.b-cont',
    generatedAt: new Date().toISOString(),
    surface: 'refresh + refresh-revocation + access-token-revocation + repository (real sqlite DB)',
    jwt: finalRep.categories.jwt,
    refresh: finalRep.categories.refresh,
    repository: finalRep.categories.repository,
    mismatches: finalRep.mismatches,
    verificationFailures: finalRep.verificationFailures,
    jwtParityPct: finalRep.jwtParityPct,
    refreshParityPct: finalRep.refreshParityPct,
    repositoryParityPct: finalRep.repositoryParityPct,
  };
  const outDir = join(ROOT, 'architecture/phase-20.b/evidence');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'identity-db-parity.json'), JSON.stringify(evidence, null, 2) + '\n');
} catch (e) {
  failures++;
  console.error('DB parity harness error:', e.message);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? '\nResult: PASS — refresh/revocation/repository parity 100% (real comparisons)' : `\nResult: FAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
