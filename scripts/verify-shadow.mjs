#!/usr/bin/env node
/**
 * verify-shadow.mjs — Phase 18.0 (B1/B3 remediation).
 *
 * A sqlite-FREE, run-anywhere parity gate for every consumed Enterprise shadow. It boots the
 * Enterprise Host with an injected fake application (no HTTP, no DB) and asserts:
 *   • with all shadow flags ON  → each shadow reaches 100% parity (and 100% coverage where the
 *     report exposes coveragePct), 0 mismatches, 0 verification failures;
 *   • with all shadow flags OFF → no adapter is consumed (byte-identical-to-legacy posture).
 *
 * This complements the HTTP-level A/B harnesses (tests/integration/*-ab.mjs), which require the
 * sqlite3 native binding and run in CI's `ab-compat` job. This script runs in ANY environment,
 * so shadow parity is verifiable everywhere (closing "A/B never run" for the parity dimension).
 *
 *   node scripts/verify-shadow.mjs        # exit 0 = all shadows 100% parity; non-zero on drift
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { bootEnterprise } = require(join(ROOT, 'src/enterprise'));

const quiet = { info() {}, warn() {}, error() {}, success() {}, fatal() {} };
function fakeApp() {
  let listening = false;
  return {
    port: 3999,
    listening: () => listening,
    start: async () => {
      listening = true;
    },
    stop: async () => {
      listening = false;
    },
  };
}

let failures = 0;
const line = (ok, msg) => {
  console.log(`  ${ok ? '✅' : '❌'} ${msg}`);
  if (!ok) failures++;
};

// ── 1) All shadows ON → 100% parity ────────────────────────────────────────────────
const on = await bootEnterprise({
  logger: quiet,
  createApplication: fakeApp,
  installSignalHandlers: false,
  platformConfig: true,
  shadowConfig: true,
  platformObservability: true,
  shadowObservability: true,
  platformJobs: true,
  shadowJobs: true,
  platformScheduler: true,
  shadowScheduler: true,
  envExports: { PORT: 3000, NODE_ENV: 'test', JWT_SECRET: 'verify-shadow-secret' },
});

const reports = {
  configuration: on.parity,
  observability: on.observabilityParity,
  jobs: on.jobsParity,
  scheduler: on.schedulerParity,
};

console.log('Shadow parity (all flags ON):');
for (const [name, r] of Object.entries(reports)) {
  const mm = r ? (r.mismatched ?? r.mismatches) : undefined; // config uses `mismatches`
  line(r && r.parityPct === 100, `${name.padEnd(14)} parity ${r ? r.parityPct : 'n/a'}%`);
  line(mm === 0, `${name.padEnd(14)} mismatches ${mm ?? 'n/a'}`);
  const vf = r && (r.verificationFailures ?? 0);
  line(!vf, `${name.padEnd(14)} verificationFailures ${vf ?? 0}`);
  if (r && r.coveragePct !== undefined) {
    line(r.coveragePct === 100, `${name.padEnd(14)} coverage ${r.coveragePct}%`);
  }
}
line(
  JSON.stringify(on.adapters.consumed().sort()) ===
    JSON.stringify(['configuration', 'jobs', 'observability', 'scheduler']),
  `consumed adapters = ${JSON.stringify(on.adapters.consumed().sort())}`
);
await on.host.stop();

// ── 2) All shadows OFF → nothing consumed (legacy posture) ──────────────────────────
const off = await bootEnterprise({
  logger: quiet,
  createApplication: fakeApp,
  installSignalHandlers: false,
});
console.log('\nAll flags OFF (must be inert):');
line(off.adapters.consumed().length === 0, `consumed adapters = [] (${off.adapters.consumed().length})`);
line(off.parity === null && off.jobsParity === null && off.schedulerParity === null && off.observabilityParity === null, 'no parity passes ran');
line((await off.host.verify()).ok === true, 'host verify ok');
await off.host.stop();

// ── 3) Identity shadow (Phase 20.a/b) — pure surface parity in the SAME unified gate ────────────
// Identity was previously verified only by a separate script; fold its environment-independent
// (pure) surface into verify:shadow so all five shadows share one gate. DB/HTTP/socket surfaces
// remain in the dedicated identity harnesses (they need a DB / live server).
{
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-shadow-secret';
  const { generateJWT, verifyJWT } = require(join(ROOT, 'src/middleware/auth'));
  const { attachIdentityShadow } = require(join(ROOT, 'src/enterprise/identityShadow'));
  const adminPhones = ['999000111'];
  const payloads = [
    { phone: '111', type: 'passenger', role: 'passenger' },
    { phone: '999000111', type: 'passenger', role: 'passenger' }, // admin by phone
    { phone: '333', type: 'passenger', role: 'admin' }, // admin by role
    { phone: '222', type: 'driver', role: 'driver', driverId: 7 },
  ];
  const tokens = [...payloads.map((p) => generateJWT(p)), 'x.y.z', null];
  const idShadow = attachIdentityShadow({
    platformIdentity: true,
    shadowIdentity: true,
    primitives: { generateJWT, verifyJWT, adminPhones, requireOtp: true },
    logger: quiet,
  });
  const r = idShadow.verifyAll({ tokens, payloads });
  console.log('\nIdentity shadow (pure surface):');
  line(r.overallParityPct === 100, `identity       parity ${r.overallParityPct}%`);
  line(r.mismatches === 0, `identity       mismatches ${r.mismatches}`);
  line(r.verificationFailures === 0, `identity       verificationFailures ${r.verificationFailures}`);
  line(r.jwtParityPct === 100 && r.authorizationParityPct === 100 && r.otpParityPct === 100, `identity       jwt/authz/otp ${r.jwtParityPct}/${r.authorizationParityPct}/${r.otpParityPct}%`);
  // Inert when disabled (mirrors the other shadows' both-off posture).
  const idOff = attachIdentityShadow({ platformIdentity: true, shadowIdentity: false, primitives: { generateJWT, verifyJWT, adminPhones, requireOtp: true } });
  line(idOff.verifyAll({ tokens, payloads }).comparisons === 0, 'identity       inert when SHADOW_IDENTITY=0');
}

console.log(
  failures === 0
    ? '\nResult: PASS — all consumed shadows (config/observability/jobs/scheduler/identity) at 100% parity; inert when disabled'
    : `\nResult: FAIL — ${failures} assertion(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
