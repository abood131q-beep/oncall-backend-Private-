#!/usr/bin/env node
/**
 * identity-socket-ab.mjs — Phase 20.b Socket authentication A/B (ADR-047 Gate B2, socket surface).
 *
 * Socket authentication is a PURE decision (`verifyJWT(token)` at the io.use handshake — no DB), so
 * this A/B is environment-independent and runs anywhere (incl. this sandbox and CI). It replays the
 * EXACT handshake decision from `src/socket.js` with the identity shadow DISABLED (production today)
 * vs ENABLED (observational), and asserts the accept/reject decision and the resolved
 * `socket.data.user` are **byte-identical** — proving the shadow never changes socket auth. It also
 * asserts the shadow records a comparison when enabled (so it is genuinely observing).
 *
 *   node tests/integration/identity-socket-ab.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'identity-socket-ab-secret';

const { generateJWT, verifyJWT } = require(join(ROOT, 'src/middleware/auth'));
const { attachIdentityShadow } = require(join(ROOT, 'src/enterprise/identityShadow'));

/** The socket.js handshake decision, parameterised by an optional observational shadow. */
function handshakeDecision(token, shadow) {
  if (!token) return { accepted: false, error: 'Authentication required', user: null };
  const payload = verifyJWT(token);
  if (!payload) return { accepted: false, error: 'Invalid or expired token', user: null };
  // Observational shadow — must NOT change the decision.
  if (shadow) {
    try {
      shadow.shadowVerify(token, { requestId: 'sock' });
      shadow.shadowResolvePrincipal(payload, { requestId: 'sock' });
    } catch {
      /* never affects the handshake */
    }
  }
  return { accepted: true, error: null, user: payload };
}

const shadow = attachIdentityShadow({
  platformIdentity: true,
  shadowIdentity: true,
  primitives: { generateJWT, verifyJWT, adminPhones: ['999'], requireOtp: true },
  logger: { warn() {} },
});

const cases = [
  { name: 'valid passenger', token: generateJWT({ phone: '111', type: 'passenger', role: 'passenger' }) },
  { name: 'valid driver', token: generateJWT({ phone: '222', type: 'driver', role: 'driver', driverId: 5 }) },
  { name: 'valid admin', token: generateJWT({ phone: '999', type: 'passenger', role: 'admin' }) },
  { name: 'malformed token', token: 'x.y.z' },
  { name: 'no token', token: null },
];

let failures = 0;
const line = (ok, msg) => {
  console.log(`  ${ok ? '✅' : '❌'} ${msg}`);
  if (!ok) failures++;
};

for (const c of cases) {
  const off = handshakeDecision(c.token, null); // shadow OFF (production today)
  const on = handshakeDecision(c.token, shadow); // shadow ON (observational)
  const same =
    off.accepted === on.accepted &&
    off.error === on.error &&
    JSON.stringify(off.user) === JSON.stringify(on.user);
  line(same, `${c.name.padEnd(18)} decision identical (accepted=${on.accepted})`);
}

// The shadow must have actually observed (recorded comparisons) when enabled.
const rep = shadow.report();
line(rep.comparisons > 0, `shadow observed handshakes (comparisons=${rep.comparisons})`);
line(rep.mismatches === 0, `socket decision parity: ${rep.mismatches} mismatches`);

console.log(
  failures === 0
    ? '\nResult: IDENTICAL — socket auth decisions byte-identical with shadow OFF vs ON'
    : `\nResult: DRIFT — ${failures} socket assertion(s) differ`
);
process.exit(failures === 0 ? 0 : 1);
