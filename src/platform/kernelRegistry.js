'use strict';

/**
 * Kernel Registry (Phase 16.1 / ADR-042 §3) — a deterministic registry of kernel
 * DESCRIPTORS (not instances). It is created per-platform inside a closure: NO global
 * variables, NO singleton state, so two platforms never share registry state.
 *
 * A descriptor declares how the composition root should compose a kernel WITHOUT the
 * registry itself knowing kernel internals:
 *   { name, adr, dependsOn[], needs[], ports[], serviceKey, factory, start?, stop? }
 *     • dependsOn — other kernel names this kernel is ordered after
 *     • needs     — context slices this kernel receives (nothing more)
 *     • ports     — dependency kernel names whose services are injected as `ports`
 *     • serviceKey— key on the factory's return object holding the kernel service
 *     • factory   — the kernel's own create*Platform(deps) composition root
 *
 * Exposes: register(), resolve(), list(), verify(). Registration order is preserved
 * and used as the deterministic tiebreak for topological ordering.
 */

const {
  DuplicateKernelError,
  KernelResolutionError,
  PlatformValidationError,
} = require('./errors');

function createKernelRegistry() {
  const order = []; // registration order (names)
  const byName = new Map(); // name -> frozen descriptor

  function register(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') {
      throw new PlatformValidationError('kernelRegistry.register: descriptor object required');
    }
    const { name, factory } = descriptor;
    if (!name || typeof name !== 'string') {
      throw new PlatformValidationError('kernelRegistry.register: descriptor.name required');
    }
    if (typeof factory !== 'function') {
      throw new PlatformValidationError(
        `kernelRegistry.register: descriptor.factory for "${name}" must be a function`
      );
    }
    if (byName.has(name)) {
      throw new DuplicateKernelError(`kernelRegistry: kernel "${name}" already registered`);
    }
    const frozen = Object.freeze({
      name,
      adr: descriptor.adr || null,
      dependsOn: Object.freeze([...(descriptor.dependsOn || [])]),
      needs: Object.freeze([...(descriptor.needs || [])]),
      ports: Object.freeze([...(descriptor.ports || [])]),
      serviceKey: descriptor.serviceKey || null,
      factory,
      start: typeof descriptor.start === 'function' ? descriptor.start : null,
      stop: typeof descriptor.stop === 'function' ? descriptor.stop : null,
      metadata: Object.freeze({ ...(descriptor.metadata || {}) }),
    });
    byName.set(name, frozen);
    order.push(name);
    return frozen;
  }

  function resolve(name) {
    const d = byName.get(name);
    if (!d) throw new KernelResolutionError(`kernelRegistry: kernel "${name}" is not registered`);
    return d;
  }

  function has(name) {
    return byName.has(name);
  }

  function list() {
    return order.map((n) => byName.get(n));
  }

  /** Structural verification: every declared dependency/port is itself registered. */
  function verify() {
    const issues = [];
    const known = new Set(order);
    for (const name of order) {
      const d = byName.get(name);
      for (const dep of d.dependsOn) {
        if (!known.has(dep)) {
          issues.push({ kernel: name, reason: 'missing dependency', dependency: dep });
        }
      }
      for (const p of d.ports) {
        if (!known.has(p)) {
          issues.push({ kernel: name, reason: 'missing port dependency', port: p });
        }
      }
    }
    return { ok: issues.length === 0, count: order.length, issues };
  }

  return { register, resolve, has, list, verify };
}

module.exports = { createKernelRegistry };
