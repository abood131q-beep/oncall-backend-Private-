#!/usr/bin/env node
/** Drivers Strangler Fig A/B compatibility harness. It boots the real service
 * twice (DRIVERS_LEGACY=1 and default) on fresh databases and compares ordered
 * JSON text after normalizing only JWTs and datetimes. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN = '11111111';
const normalize = (text) => text.replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<JWT>').replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/g, '<DATETIME>');
async function boot(legacy, port, db) {
  const child = spawn(process.execPath, ['--no-warnings', '-r', './tools/dev/sqlite3-compat.js', 'server.js'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'development', JWT_SECRET: 'drivers-ab-secret-0123456789abcdef0123456789abcdef', ADMIN_PHONES: ADMIN, PORT: String(port), DB_PATH: db, LOG_LEVEL: 'ERROR', DRIVERS_LEGACY: legacy ? '1' : '0' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 60; n++) { await new Promise((r) => setTimeout(r, 200)); try { if ((await fetch(`${base}/health`)).status === 200) return { child, base }; } catch {} }
  child.kill('SIGKILL'); throw new Error(`server did not start (legacy=${legacy})`);
}
async function call(base, method, path, options = {}) { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) }); return { status: r.status, text: normalize(await r.text()) }; }
async function scenarios(base) {
  const out = []; const step = async (name, method, path, options) => out.push([name, await call(base, method, path, options)]);
  const rawAdmin = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: ADMIN }) }).then((r) => r.json());
  const driverPhone = '99990123';
  await step('driver-login-pending', 'POST', '/driver/login', { body: { phone: driverPhone } });
  await step('admin-list', 'GET', '/admin/drivers', { token: rawAdmin.token });
  await step('admin-pending', 'GET', '/admin/drivers/pending', { token: rawAdmin.token });
  await step('approve-noauth', 'PUT', `/admin/drivers/${driverPhone}/approve`, { body: {} });
  await step('approve', 'PUT', `/admin/drivers/${driverPhone}/approve`, { token: rawAdmin.token, body: {} });
  const login = await fetch(base + '/driver/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: driverPhone }) }).then((r) => r.json());
  await step('status-online', 'POST', '/driver/status', { token: login.token, body: { isOnline: true } });
  await step('info-idor-path', 'GET', '/driver/info/other-phone', { token: login.token });
  await step('update-profile', 'POST', '/driver/update', { token: login.token, body: { name: 'Driver AB', car_name: 'Camry', plate: 'AB-1' } });
  await step('stats', 'GET', '/driver/stats/other-phone', { token: login.token });
  await step('reviews', 'GET', '/driver/reviews/other-phone', { token: login.token });
  await step('reject-short', 'PUT', `/admin/drivers/${driverPhone}/reject`, { token: rawAdmin.token, body: { reason: 'bad' } });
  await step('suspend', 'PUT', `/admin/drivers/${driverPhone}/suspend`, { token: rawAdmin.token, body: { reason: 'AB suspension reason' } });
  await step('reactivate', 'PUT', `/admin/drivers/${driverPhone}/reactivate`, { token: rawAdmin.token, body: {} });
  await step('history', 'GET', `/admin/drivers/${driverPhone}/approval-history`, { token: rawAdmin.token });
  return out;
}
const dir = mkdtempSync(join(tmpdir(), 'drivers-ab-')); let a; let b; try { a = await boot(true, 4901, join(dir, 'legacy.db')); b = await boot(false, 4902, join(dir, 'new.db')); const [left, right] = await Promise.all([scenarios(a.base), scenarios(b.base)]); let fails = 0; for (let i = 0; i < left.length; i++) { const ok = left[i][1].status === right[i][1].status && left[i][1].text === right[i][1].text; console.log(`  ${ok ? '✓' : '✗'} ${left[i][0]}`); if (!ok) { fails++; console.log(' legacy', left[i][1], '\n new   ', right[i][1]); } } console.log(`Drivers A/B: ${left.length - fails}/${left.length} byte-identical`); process.exitCode = fails ? 1 : 0; } finally { a?.child.kill('SIGKILL'); b?.child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
