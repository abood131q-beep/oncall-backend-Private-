'use strict';

/**
 * Memory secrets provider (Phase 14.9 / ADR-028 §4) — in-process persistence of
 * secret + version models. Single-process; the seam a future Vault / AWS Secrets
 * Manager / Azure Key Vault / GCP Secret Manager adapter slots behind. It performs
 * NO secret behavior (no rotation, redaction, integrity, or events) — that lives
 * in the engine. Each namespace keeps, per secret name, the current model plus an
 * append-only map of historical versions.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> Map(name -> { current, versions: Map(version->model) })
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, new Map());
    return ns.get(namespace);
  };
  const clone = (m) => (m ? JSON.parse(JSON.stringify(m)) : m);

  return {
    name: opts.name || 'memory',
    putSecret(namespace, model) {
      const b = bucket(namespace);
      let entry = b.get(model.name);
      if (!entry) {
        entry = { current: null, versions: new Map() };
        b.set(model.name, entry);
      }
      const stored = clone(model);
      entry.current = stored;
      entry.versions.set(stored.version, clone(model));
      return Promise.resolve();
    },
    getSecret(namespace, name) {
      const b = ns.get(namespace);
      const entry = b && b.get(name);
      return Promise.resolve(entry && entry.current ? clone(entry.current) : null);
    },
    getSecretVersion(namespace, name, version) {
      const b = ns.get(namespace);
      const entry = b && b.get(name);
      return Promise.resolve(
        entry && entry.versions.has(version) ? clone(entry.versions.get(version)) : null
      );
    },
    listSecrets(namespace) {
      const b = ns.get(namespace);
      if (!b) return Promise.resolve([]);
      return Promise.resolve([...b.values()].filter((e) => e.current).map((e) => clone(e.current)));
    },
    listVersions(namespace, name) {
      const b = ns.get(namespace);
      const entry = b && b.get(name);
      return Promise.resolve(entry ? [...entry.versions.keys()].sort((a, z) => a - z) : []);
    },
    removeSecret(namespace, name) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.delete(name) : false);
    },
    health() {
      let secrets = 0;
      let versions = 0;
      for (const b of ns.values()) {
        for (const entry of b.values()) {
          secrets += 1;
          versions += entry.versions.size;
        }
      }
      return { ok: true, provider: 'memory', namespaces: ns.size, secrets, versions };
    },
  };
}

module.exports = { createMemoryProvider };
