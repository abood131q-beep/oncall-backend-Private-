#!/usr/bin/env node
/**
 * Architecture Verification — the permanent, executable governance authority
 * (Phase 3.5, ADR-012 Enterprise Governance · ADR-015 Manifesto).
 *
 * Auto-discovers every file in the enterprise layers (src/domain,
 * src/application, src/infrastructure, src/presentation) and mechanically
 * enforces the automatable architecture rules (see RULES.md). Exits non-zero
 * on any CRITICAL violation so it can gate CI (ADR-009 quality pipeline).
 *
 * Run: node architecture/compliance/verify-architecture.mjs
 *      node architecture/compliance/verify-architecture.mjs --json
 *
 * This file introduces NO framework, NO SQL, NO runtime coupling to the app.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAYERS = ['domain', 'application', 'infrastructure', 'presentation'];

// ── File discovery ────────────────────────────────────────────────────────────
function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out = out.concat(walk(p));
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

const layerFiles = {};
for (const l of LAYERS) layerFiles[l] = walk(join(ROOT, 'src', l));
const all = LAYERS.flatMap((l) => layerFiles[l]);

// ── Helpers ───────────────────────────────────────────────────────────────────
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
const codeOf = (f) => strip(readFileSync(f, 'utf8'));
const requiresOf = (src) => [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
const rel = (f) => relative(ROOT, f);
const SQL = /\b(SELECT\s|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|BEGIN\s+(IMMEDIATE|TRANSACTION))\b/i;

const violations = [];
function record(rule, severity, adr, file, detail) {
  violations.push({ rule, severity, adr, file: rel(file), detail });
}

// ── Rules ─────────────────────────────────────────────────────────────────────
// R1 — No framework (Express/Socket.IO) in Domain or Application. [CRITICAL, ADR-005]
for (const layer of ['domain', 'application']) {
  for (const f of layerFiles[layer]) {
    const reqs = requiresOf(codeOf(f));
    if (reqs.some((r) => r === 'express' || r.includes('socket.io'))) {
      record('R1-no-framework-in-core', 'CRITICAL', 'ADR-005', f, 'imports a web framework');
    }
  }
}

// R2 — No SQL outside Infrastructure. [CRITICAL, ADR-004/005]
for (const layer of ['domain', 'application', 'presentation']) {
  for (const f of layerFiles[layer]) {
    if (SQL.test(codeOf(f))) {
      record('R2-no-sql-outside-infra', 'CRITICAL', 'ADR-004', f, 'contains SQL text');
    }
  }
}

// R3 — Presentation must not import Domain, Infrastructure, or the database. [CRITICAL, ADR-005]
// Exception: a *Routes.js composition root wires Infrastructure adapters (accepted
// composition-root pattern); the request handler (*Controller.js) must stay pure.
for (const f of layerFiles.presentation) {
  const isCompositionRoot = /Routes\.js$/.test(f);
  const reqs = requiresOf(codeOf(f));
  if (reqs.some((r) => r.includes('/domain/'))) {
    record('R3-presentation-no-domain', 'CRITICAL', 'ADR-005', f, 'imports Domain directly');
  }
  if (!isCompositionRoot) {
    if (reqs.some((r) => r.includes('/infrastructure/') || r.includes('database') || r.includes('sqlite'))) {
      record('R3-controller-no-infra-db', 'CRITICAL', 'ADR-005', f, 'controller imports Infrastructure/DB');
    }
  }
}

// R4 — Domain depends on nothing above it. [CRITICAL, ADR-005 §18]
for (const f of layerFiles.domain) {
  const reqs = requiresOf(codeOf(f));
  if (reqs.some((r) => r.includes('/application/') || r.includes('/infrastructure/') || r.includes('/presentation/'))) {
    record('R4-domain-pure', 'CRITICAL', 'ADR-005', f, 'imports an outer layer');
  }
}

// R5 — Application depends only downward (Domain), never Infrastructure/Presentation. [CRITICAL, ADR-005]
for (const f of layerFiles.application) {
  const reqs = requiresOf(codeOf(f));
  if (reqs.some((r) => r.includes('/infrastructure/') || r.includes('/presentation/'))) {
    record('R5-application-downward-only', 'CRITICAL', 'ADR-005', f, 'imports Infrastructure/Presentation');
  }
}

// R6 — No circular dependencies among enterprise-layer files. [CRITICAL, ADR-005/008]
const resolveLocal = (from, r) => {
  if (!r.startsWith('.')) return null;
  const p = join(dirname(from), r);
  return p.endsWith('.js') ? p : p + '.js';
};
const graph = new Map();
for (const f of all) graph.set(f, requiresOf(codeOf(f)).map((r) => resolveLocal(f, r)).filter((x) => x && all.includes(x)));
let cycle = null;
const color = new Map(all.map((f) => [f, 0]));
const stack = [];
const dfs = (n) => {
  color.set(n, 1);
  stack.push(n);
  for (const m of graph.get(n) || []) {
    if (color.get(m) === 1) {
      cycle = [...stack.slice(stack.indexOf(m)), m].map(rel);
      return true;
    }
    if (color.get(m) === 0 && dfs(m)) return true;
  }
  stack.pop();
  color.set(n, 2);
  return false;
};
for (const f of all) if (color.get(f) === 0 && dfs(f)) break;
if (cycle) record('R6-no-cycles', 'CRITICAL', 'ADR-005', all[0], `cycle: ${cycle.join(' → ')}`);

// R7 — Application composition roots verify their ports (fail-fast). [MAJOR, ADR-005 §2]
for (const f of layerFiles.application) {
  if (/\/index\.js$/.test(f)) {
    const src = codeOf(f);
    if (!/assertPorts|createLocalizationService|verified/.test(src) && /createUsersApplication|createIdentityApplication/.test(src)) {
      record('R7-ports-asserted', 'MAJOR', 'ADR-005', f, 'application index does not assert ports');
    }
  }
}

// R8 — Configuration read seam (Phase 18.3). Application code must read config ONLY through the
// runtime facade `src/config/index.js` (config.get/require). No NEW module may import
// `src/config/env.js` directly. [MAJOR, ADR-046/G1.0 — config-seam invariant]
//
// This is a RATCHET: the LEGACY_ALLOWLIST holds the pre-facade consumers not yet migrated; it may
// only SHRINK. EXEMPT holds files that legitimately read env.js by design (the facade itself, the
// env module, and the Configuration shadow's authoritative legacy source).
{
  const EXEMPT = new Set([
    'src/config/env.js', // the source module itself
    'src/config/index.js', // the facade — the ONE approved backing point
    'src/platform-adapters/configuration/legacySource.js', // shadow's legacy source-of-truth (by design)
  ]);
  // Phase 18.4: migration COMPLETE — allowlist is empty. No runtime consumer of env.js remains.
  // Only the EXEMPT files above may read env.js. Any direct import is now a hard R8 violation.
  const LEGACY_ALLOWLIST = new Set([]);
  const DIRECT_ENV = /require\(['"][^'"]*config\/env['"]\)/;
  const scan = [...walk(join(ROOT, 'src')), join(ROOT, 'server.js')];
  for (const f of scan) {
    const rf = rel(f);
    if (EXEMPT.has(rf)) continue;
    if (!DIRECT_ENV.test(codeOf(f))) continue;
    if (LEGACY_ALLOWLIST.has(rf)) continue; // permitted legacy consumer (pending migration)
    record('R8-config-read-seam', 'MAJOR', 'ADR-046', f, 'reads config/env directly — use the config facade (config.get/require)');
  }
}

// R9 — Edge-layer purity (Phase 20.b-cont). `src/middleware/` and `src/services/` are NOT among the
// four ADR-005 layers the gate scans (R1–R7), so raw SQL and token crypto have historically hidden
// there (Phase 19.1 V1/V2 — the "governance blind spot"). R9 closes it: no NEW raw SQL and no NEW
// token-signing crypto (HMAC) may live in these edge folders; they belong in `infrastructure/` and
// the Identity kernel. [MAJOR, ADR-005/ADR-049]
//
// RATCHET: the allowlists hold the pre-existing debt (documented in Phase 19.1) and may only SHRINK
// as each responsibility is migrated into the kernel. Any file NOT on the allowlist that introduces
// SQL / HMAC in these folders is a hard violation.
{
  const EDGE_DIRS = [join(ROOT, 'src', 'middleware'), join(ROOT, 'src', 'services')];
  // Existing raw-SQL debt in the edge layers (Phase 19.1). Shrinks as migrated.
  const SQL_ALLOWLIST = new Set([
    'src/middleware/auth.js', // JWT refresh + revocation SQL (19.1 V2 — → Identity infrastructure)
    'src/middleware/rateLimiter.js', // rate-limit locks SQL (→ infrastructure)
    'src/services/otpService.js', // OTP store SQL (→ Identity infrastructure)
    'src/services/driverMatcher.js',
    'src/services/analytics.js',
    'src/services/notificationService.js',
  ]);
  // Existing token-crypto debt (Phase 19.1 V1). Shrinks as the JWT core moves into the kernel.
  const CRYPTO_ALLOWLIST = new Set([
    'src/middleware/auth.js', // hand-rolled HS256 JWT signing (→ Identity infrastructure token crypto)
  ]);
  const HMAC = /\bcreateHmac\s*\(/;
  const edgeFiles = EDGE_DIRS.flatMap((d) => walk(d));
  for (const f of edgeFiles) {
    const rf = rel(f);
    const code = codeOf(f);
    if (SQL.test(code) && !SQL_ALLOWLIST.has(rf)) {
      record('R9-no-sql-in-edge', 'MAJOR', 'ADR-005', f, 'raw SQL in middleware/services — belongs in infrastructure/');
    }
    if (HMAC.test(code) && !CRYPTO_ALLOWLIST.has(rf)) {
      record('R9-no-token-crypto-in-edge', 'MAJOR', 'ADR-049', f, 'token-signing crypto (HMAC) in middleware/services — belongs in the Identity kernel');
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const asJson = process.argv.includes('--json');
const crit = violations.filter((v) => v.severity === 'CRITICAL');
const major = violations.filter((v) => v.severity === 'MAJOR');

if (asJson) {
  console.log(JSON.stringify({ scanned: all.length, layers: Object.fromEntries(LAYERS.map((l) => [l, layerFiles[l].length])), violations }, null, 2));
} else {
  console.log('OnCall — Architecture Verification (Phase 3.5)');
  console.log('='.repeat(58));
  console.log(`Enterprise-layer files scanned: ${all.length}`);
  for (const l of LAYERS) console.log(`  ${l.padEnd(15)} ${layerFiles[l].length}`);
  console.log('-'.repeat(58));
  const RULES = ['R1-no-framework-in-core', 'R2-no-sql-outside-infra', 'R3-presentation-no-domain', 'R3-controller-no-infra-db', 'R4-domain-pure', 'R5-application-downward-only', 'R6-no-cycles', 'R7-ports-asserted', 'R8-config-read-seam', 'R9-no-sql-in-edge', 'R9-no-token-crypto-in-edge'];
  for (const r of RULES) {
    const hits = violations.filter((v) => v.rule === r);
    console.log(`  ${hits.length === 0 ? '✔ PASS' : '✗ FAIL'}  ${r}${hits.length ? '  (' + hits.length + ')' : ''}`);
  }
  console.log('-'.repeat(58));
  if (violations.length === 0) {
    console.log('✅ ARCHITECTURE COMPLIANCE: PASS (0 violations)');
  } else {
    for (const v of violations) console.log(`  [${v.severity}] ${v.rule} — ${v.file}: ${v.detail} (${v.adr})`);
    console.log(`\n❌ ${crit.length} critical, ${major.length} major violation(s)`);
  }
}

process.exit(crit.length > 0 ? 1 : 0);
