'use strict';

/**
 * Memory provider (Phase 14.3.2 §2) — an in-process source backing any layer.
 * Ideal for defaults, runtime overrides, tests, and as the seam a future
 * distributed provider (Redis/etcd/Consul) will slot behind. Supports change
 * watching: `set`/`setAll`/`delete` notify watchers, enabling live reload.
 *
 * DI: `{ initial, layer, name }`.
 */

function createMemoryProvider(opts = {}) {
  const store = new Map(Object.entries(opts.initial || {}));
  const watchers = new Set();
  const layer = opts.layer || 'provider';

  function notify() {
    for (const cb of watchers) {
      try {
        cb();
      } catch {
        /* watcher errors are isolated */
      }
    }
  }

  return {
    name: opts.name || 'memory',
    layer,
    load() {
      return Promise.resolve(Object.fromEntries(store));
    },
    get(key) {
      return Promise.resolve(store.get(key));
    },
    // Mutation API (memory-only) — drives live reload in tests and runtime overrides.
    set(key, value) {
      store.set(key, value);
      notify();
      return this;
    },
    setAll(obj) {
      for (const [k, v] of Object.entries(obj || {})) store.set(k, v);
      notify();
      return this;
    },
    delete(key) {
      store.delete(key);
      notify();
      return this;
    },
    watch(cb) {
      watchers.add(cb);
      return () => watchers.delete(cb);
    },
  };
}

module.exports = { createMemoryProvider };
