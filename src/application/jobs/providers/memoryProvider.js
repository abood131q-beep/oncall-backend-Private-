'use strict';

/**
 * Memory jobs provider (Phase 15.3 / ADR-032 §4) — in-process persistence of job
 * models. Single-process; the seam a future Redis / PostgreSQL / Storage / MongoDB
 * / message-queue adapter slots behind. It performs NO execution behavior (no
 * handler invocation, retry, timeout, dead-letter, or events) — that lives in the
 * engine.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> Map(jobId -> model)
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, new Map());
    return ns.get(namespace);
  };
  const clone = (m) => (m == null ? m : JSON.parse(JSON.stringify(m)));

  return {
    name: opts.name || 'memory',
    putJob(namespace, model) {
      bucket(namespace).set(model.jobId, clone(model));
      return Promise.resolve();
    },
    getJob(namespace, jobId) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.has(jobId) ? clone(b.get(jobId)) : null);
    },
    listJobs(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.values()].map(clone) : []);
    },
    removeJob(namespace, jobId) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.delete(jobId) : false);
    },
    health() {
      let jobs = 0;
      for (const b of ns.values()) jobs += b.size;
      return { ok: true, provider: 'memory', namespaces: ns.size, jobs };
    },
  };
}

module.exports = { createMemoryProvider };
