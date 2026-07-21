#!/usr/bin/env node
/**
 * run-ab.mjs — Phase 12 (C5): run EVERY A/B compatibility harness and fail hard
 * on any contract drift. This wires the migration's byte-identical guarantee into
 * CI (the audit found it was manually-run and unenforced). Exit non-zero if any
 * harness fails, so the build blocks on any public-contract regression.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'tests', 'integration');

const harnesses = readdirSync(DIR)
  .filter((f) => f.endsWith('-ab.mjs'))
  .sort();

let failed = 0;
console.log(`\n▶ Running ${harnesses.length} A/B compatibility harnesses\n${'='.repeat(56)}`);
// Hard per-harness timeout so a single hanging harness can never stall the CI job
// indefinitely (a timeout is treated as a FAILURE, never a skip).
const HARNESS_TIMEOUT_MS = Number(process.env.AB_HARNESS_TIMEOUT_MS || 300000);
for (const h of harnesses) {
  process.stdout.write(`  • ${h.padEnd(24)} `);
  const r = spawnSync(process.execPath, [join(DIR, h)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: HARNESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (r.error && r.error.code === 'ETIMEDOUT') {
    failed++;
    console.log(`❌ TIMEOUT after ${HARNESS_TIMEOUT_MS / 1000}s (killed)`);
    continue;
  }
  const out = (r.stdout || '') + (r.stderr || '');
  const line = out.split('\n').find((l) => /Result:|IDENTICAL/.test(l)) || '';
  if (r.status === 0) {
    console.log(`✅ ${line.trim()}`);
  } else {
    failed++;
    console.log(`❌ FAILED (exit ${r.status})`);
    console.log(out.split('\n').slice(-12).join('\n'));
  }
}
console.log('='.repeat(56));
console.log(failed === 0 ? `✅ ALL ${harnesses.length} A/B harnesses byte-identical` : `❌ ${failed} harness(es) FAILED`);
process.exit(failed === 0 ? 0 : 1);
