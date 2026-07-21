'use strict';

/**
 * identityKernelSkeleton.test.js — Phase 19.4
 *
 * Proves the consolidated Identity Kernel SKELETON is structurally sound and INERT:
 * - domain value objects (principal/session) are pure and frozen;
 * - ports assert fail-fast; the kernel composes with a valid port set;
 * - every kernel use case + every infra adapter throws IdentityKernelNotWired (no behavior moved);
 * - provider registry + metrics + diagnostics expose the expected shape;
 * - composing the skeleton does NOT touch or import the production auth path.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const domain = require('../../src/domain/identity/kernel');
const {
  createIdentityKernel,
  assertPorts,
  createProviderRegistry,
  createIdentityKernelMetrics,
} = require('../../src/application/identity/kernel');
const { createIdentityInfrastructure } = require('../../src/infrastructure/identity');
const { IdentityKernelNotWired, IdentityPortError } = require('../../src/domain/identity/kernel/errors');

test('domain: principal is frozen and shape-correct', () => {
  const p = domain.createPrincipal({ subject: '123', roles: ['admin'], claims: { a: 1 } });
  assert.equal(p.subject, '123');
  assert.deepEqual([...p.roles], ['admin']);
  assert.ok(Object.isFrozen(p));
  assert.equal(domain.isPrincipal(p), true);
});

test('domain: session isLive predicate is pure', () => {
  const s = domain.createSession({ sessionId: 's1', expiresAt: 1000, state: 'active' });
  assert.equal(domain.isLive(s, 500), true);
  assert.equal(domain.isLive(s, 2000), false);
});

test('domain: authorization policies mirror legacy (Phase 20.a — implemented, non-authoritative)', () => {
  // isAdmin: admin role OR configured admin phone (mirrors legacy authenticateAdmin).
  const admins = ['999'];
  assert.equal(domain.isAdmin(domain.createPrincipal({ claims: { role: 'admin' } }), admins), true);
  assert.equal(domain.isAdmin(domain.createPrincipal({ claims: { phone: '999' } }), admins), true);
  assert.equal(domain.isAdmin(domain.createPrincipal({ claims: { phone: '111' } }), admins), false);
  assert.equal(domain.isAdmin(null, admins), false);
  // can/hasRole are pure set checks.
  assert.equal(domain.hasRole(domain.createPrincipal({ roles: ['driver'] }), 'driver'), true);
  assert.equal(domain.can(domain.createPrincipal({ permissions: ['x'] }), 'x'), true);
});

test('ports: assertPorts fails fast on a missing port / method', () => {
  assert.throws(() => assertPorts({}), IdentityPortError);
  assert.throws(() => assertPorts({ tokenPort: {} }), IdentityPortError);
});

test('infrastructure: skeleton port set satisfies assertPorts', () => {
  const ports = createIdentityInfrastructure();
  assert.doesNotThrow(() => assertPorts(ports));
});

test('infrastructure: every adapter method is inert (IdentityKernelNotWired)', () => {
  const ports = createIdentityInfrastructure();
  assert.throws(() => ports.tokenPort.issueAccessToken({}), IdentityKernelNotWired);
  assert.throws(() => ports.otpPort.verify('p', '1'), IdentityKernelNotWired);
  assert.throws(() => ports.identityRepositoryPort.findUserByPhone('p'), IdentityKernelNotWired);
  assert.throws(() => ports.sessionStorePort.find('s'), IdentityKernelNotWired);
});

test('kernel: composes with a valid port set and reports skeleton phase', () => {
  const kernel = createIdentityKernel({ ports: createIdentityInfrastructure() });
  assert.equal(kernel.phase, 'skeleton');
  const d = kernel.diagnostics();
  assert.equal(d.wired, false);
  assert.equal(d.authoritative, false);
  assert.deepEqual(new Set(d.ports), new Set(['tokenPort', 'otpPort', 'identityRepositoryPort', 'sessionStorePort']));
});

test('kernel: every use case is inert (behavior not migrated this phase)', () => {
  const kernel = createIdentityKernel({ ports: createIdentityInfrastructure() });
  for (const fn of ['authenticate', 'refresh', 'logout', 'resolve', 'authorize']) {
    assert.throws(() => kernel[fn]({}), IdentityKernelNotWired, `${fn} should be inert`);
  }
});

test('metrics + providers expose the expected shape', () => {
  const m = createIdentityKernelMetrics();
  const snap = m.snapshot();
  for (const k of ['authAttempts', 'authSuccess', 'tokensIssued', 'activeSessions']) {
    assert.ok(k in snap, `metrics snapshot missing ${k}`);
  }
  const reg = createProviderRegistry();
  assert.deepEqual(reg.list(), ['default']);
});

test('isolation: requiring the skeleton does not pull in the production auth module', () => {
  // The kernel application layer must not depend on middleware/auth (dependency rule / isolation).
  const resolved = require.resolve('../../src/application/identity/kernel');
  const mod = require.cache[resolved];
  const pulls = (m, seen = new Set()) => {
    if (!m || seen.has(m.id)) return false;
    seen.add(m.id);
    for (const c of m.children || []) {
      if (/middleware[/\\]auth\.js$/.test(c.id)) return true;
      if (pulls(c, seen)) return true;
    }
    return false;
  };
  assert.equal(pulls(mod), false, 'kernel app layer must not import middleware/auth.js');
});
