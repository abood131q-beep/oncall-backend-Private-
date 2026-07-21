#!/usr/bin/env node
/**
 * identity-parity-report.mjs — Phase 20.b (ADR-047 Gate B2 evidence: parity/mismatch/latency/coverage).
 *
 * Runs the Identity Shadow over a representative input set (pure surface — verify/issue/header/authz/
 * otp/principal) and writes a MEASURED JSON parity report to architecture/phase-20.b/evidence/. It
 * records only what it actually measured (no fabrication). DB/HTTP/socket categories that require a
 * live server are reported with their real (0-comparison) state and flagged as CI-only.
 *
 *   node scripts/identity-parity-report.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'identity-parity-report-secret';

const { generateJWT, verifyJWT } = require(join(ROOT, 'src/middleware/auth'));
const { attachIdentityShadow } = require(join(ROOT, 'src/enterprise/identityShadow'));

const adminPhones = ['999000111'];
const payloads = [
  { phone: '111000222', type: 'passenger', role: 'passenger', name: 'P' },
  { phone: '999000111', type: 'passenger', role: 'passenger', name: 'AdminByPhone' },
  { phone: '333000444', type: 'passenger', role: 'admin', name: 'AdminByRole' },
  { phone: '222000333', type: 'driver', role: 'driver', driverId: 42, name: 'D' },
];
const tokens = [...payloads.map((p) => generateJWT(p)), 'not.a.jwt', 'a.b.c', '', null];

const shadow = attachIdentityShadow({
  platformIdentity: true,
  shadowIdentity: true,
  primitives: { generateJWT, verifyJWT, adminPhones, requireOtp: true },
  logger: { warn() {} },
});
const report = shadow.verifyAll({ tokens, payloads });

const evidence = {
  phase: '20.b',
  generatedAt: new Date().toISOString(),
  environment: { sqlite: false, liveServer: false, note: 'pure surface measured; DB/HTTP/socket categories are CI-only' },
  overallParityPct: report.overallParityPct,
  comparisons: report.comparisons,
  matches: report.matches,
  mismatches: report.mismatches,
  verificationFailures: report.verificationFailures,
  confidenceLevel: report.confidenceLevel,
  coveragePct: report.coveragePct,
  latency: report.latency,
  perCategory: report.categories,
  mismatchReport: report.mismatches_log,
};

const outDir = join(ROOT, 'architecture/phase-20.b/evidence');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'identity-parity-report.json');
writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');

console.log(`Identity parity report → ${outFile}`);
console.log(`  overall parity ${evidence.overallParityPct}%  (${evidence.comparisons} comparisons, ${evidence.mismatches} mismatch, ${evidence.verificationFailures} failures)`);
console.log(`  jwt ${report.jwtParityPct}%  authz ${report.authorizationParityPct}%  otp ${report.otpParityPct}%`);
const ok = evidence.overallParityPct === 100 && evidence.mismatches === 0 && evidence.verificationFailures === 0;
console.log(ok ? 'Result: PASS — pure-surface parity 100%' : 'Result: FAIL — parity drift measured');
process.exit(ok ? 0 : 1);
