'use strict';

/**
 * Storage metrics (Phase 14.3.4 §7) — observability port. Tracks reads, writes,
 * updates, deletes, transactions, operation latency, and cache hit/miss ratio;
 * exposes a Prometheus exposition. Pure in-process counters; injectable clock
 * keeps latency timing deterministic.
 */

function createStorageMetrics(opts = {}) {
  const now = opts.clock || (() => Date.now());
  let reads = 0;
  let writes = 0;
  let updates = 0;
  let deletes = 0;
  let transactions = 0;
  let rollbacks = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  const recordRead = () => (reads += 1);
  const recordWrite = () => (writes += 1);
  const recordUpdate = () => (updates += 1);
  const recordDelete = () => (deletes += 1);
  const recordTransaction = () => (transactions += 1);
  const recordRollback = () => (rollbacks += 1);
  const recordCache = (hit) => (hit ? (cacheHits += 1) : (cacheMisses += 1));
  function recordLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      latTotalMs += ms;
      latCount += 1;
      latLastMs = ms;
    }
  }
  /** Time an async operation and record its latency. */
  async function timeOp(fn) {
    const start = now();
    try {
      return await fn();
    } finally {
      recordLatency(now() - start);
    }
  }

  function snapshot() {
    const cacheTotal = cacheHits + cacheMisses;
    return {
      reads,
      writes,
      updates,
      deletes,
      transactions,
      rollbacks,
      avgLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastLatencyMs: latLastMs,
      cacheHits,
      cacheMisses,
      cacheHitRatio: cacheTotal ? cacheHits / cacheTotal : 0,
      cacheMissRatio: cacheTotal ? cacheMisses / cacheTotal : 0,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('storage_reads_total', 'Reads', s.reads),
        g('storage_writes_total', 'Writes (creates)', s.writes),
        g('storage_updates_total', 'Updates', s.updates),
        g('storage_deletes_total', 'Deletes', s.deletes),
        g('storage_transactions_total', 'Committed transactions', s.transactions),
        g('storage_rollbacks_total', 'Rolled-back transactions', s.rollbacks),
        g('storage_latency_ms_avg', 'Average operation latency', s.avgLatencyMs),
        g('storage_latency_ms_last', 'Last operation latency', s.lastLatencyMs),
        g('storage_cache_hit_ratio', 'Cache hit ratio', s.cacheHitRatio),
        g('storage_cache_miss_ratio', 'Cache miss ratio', s.cacheMissRatio),
      ].join('\n') + '\n'
    );
  }

  return {
    recordRead,
    recordWrite,
    recordUpdate,
    recordDelete,
    recordTransaction,
    recordRollback,
    recordCache,
    recordLatency,
    timeOp,
    snapshot,
    prometheus,
  };
}

module.exports = { createStorageMetrics };
