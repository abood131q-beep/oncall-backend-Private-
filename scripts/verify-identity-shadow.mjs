#!/usr/bin/env node
/**
 * verify-identity-shadow.mjs — Phase 20.a (ADR-046/047/049).
 *
 * A sqlite-FREE, run-anywhere parity gate for the Identity Shadow. It composes the shadow with the
 * REAL certified legacy primitives (`src/middleware/auth.js` generateJWT/verifyJWT) and the
 * Consolidated Identity Kernel path (token adapter pass-through + domain authorization), then
 * asserts the PURE identity operations reach 100% parity:
 *   • ON  → JWT verify/issue/header, admin resolution, OTP-required, principal resolution:
 *           parity 100%, 0 mismatches, 0 verification failures, across valid/invalid/admin inputs;
 *   • OFF → the shadow is inert (no comparisons; legacy passthrough only).
 *
 * DB-bound operations (refresh/revocation/repository) and request-bound ones (socket/HTTP) are
 * declared in the shadow but exercised only where a DB/live server exists (CI) — this gate covers
 * the pure, environment-independent surface (like scripts/verify-shadow.mjs for the other kernels).
 *
 *   node scripts/verify-identity-shadow.mjs      # exit 0 = 100% parity; non-zero on drift
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-identity-shadow-secret';

const { generateJWT, verifyJWT } = require(join(ROOT, 'src/middleware/auth'));
const { attachIdentityShadow } = require(join(ROOT, 'src/enterprise/identityShadow'));

let failures = 0;
const line = (ok, msg) => {
  console.log(`  ${ok ? '✅' : '❌'} ${msg}`);
  if (!ok) failures++;
};

const adminPhones = ['999000111'];
const primitives = { generateJWT, verifyJWT, adminPhones, requireOtp: true };

// Representative payloads: passenger, admin-by-phone, admin-by-role, driver.
const payloads = [
  { phone: '111000222', type: 'passenger', role: 'passenger', name: 'P' },
  { phone: '999000111', type: 'passenger', role: 'passenger', name: 'AdminByPhone' },
  { phone: '333000444', type: 'passenger', role: 'admin', name: 'AdminByRole' },
  { phone: '222000333', type: 'driver', role: 'driver', driverId: 42, name: 'D' },
];
// Tokens: valid (issued from payloads) + invalid + malformed + null.
const tokens = [...payloads.map((p) => generateJWT(p)), 'not.a.jwt', 'a.b.c', '', null];

// ── 1) Shadow ON → 100% parity on the pure surface ──────────────────────────────────
const shadow = attachIdentityShadow({
  platformIdentity: true,
  shadowIdentity: true,
  primitives,
  logger: { warn() {} },
});
const report = shadow.verifyAll({ tokens, payloads });

console.log('Identity shadow parity (PLATFORM_IDENTITY=1, SHADOW_IDENTITY=1):');
line(report.overallParityPct === 100, `overall parity ${report.overallParityPct}%`);
line(report.mismatches === 0, `mismatches ${report.mismatches}`);
line(report.verificationFailures === 0, `verificationFailures ${report.verificationFailures}`);
line(report.jwtParityPct === 100, `jwt parity ${report.jwtParityPct}%`);
line(report.authorizationParityPct === 100, `authorization parity ${report.authorizationParityPct}%`);
line(report.otpParityPct === 100, `otp parity ${report.otpParityPct}%`);
line(report.comparisons > 0, `comparisons ran = ${report.comparisons}`);

// ── 2) Shadow OFF (SHADOW_IDENTITY=0) → inert (no comparisons) ────────────────────────
const off = attachIdentityShadow({
  platformIdentity: true,
  shadowIdentity: false,
  primitives,
  logger: { warn() {} },
});
const offReport = off.verifyAll({ tokens, payloads });
console.log('\nShadow disabled (SHADOW_IDENTITY=0) — must be inert:');
line(offReport.comparisons === 0, `comparisons = ${offReport.comparisons} (expected 0)`);
line(off.shadowVerify(tokens[0]) !== undefined, 'disabled shadow still returns the legacy result');

// ── 3) PLATFORM_IDENTITY=0 → no shadow at all ─────────────────────────────────────────
const none = attachIdentityShadow({ platformIdentity: false, primitives });
line(none === null, 'PLATFORM_IDENTITY=0 → no identity shadow composed');

console.log(
  failures === 0
    ? '\nResult: PASS — Identity shadow at 100% parity on the pure surface; inert when disabled'
    : `\nResult: FAIL — ${failures} assertion(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
