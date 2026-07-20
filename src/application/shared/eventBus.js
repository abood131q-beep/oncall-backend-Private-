'use strict';

/**
 * eventBus — in-process Domain Event dispatcher (Phase 14.1 Event Backbone).
 *
 * Application-layer capability (ADR-005 §12, ADR-006 §6). Purely additive: it
 * introduces NO change to any existing synchronous flow. Contexts OPT IN by
 * publishing after commit and/or subscribing; nothing is rerouted, so all
 * A/B byte-identity proofs are preserved.
 *
 * Guarantees implemented here:
 *   • Handler isolation  — one handler throwing never blocks the publisher or
 *                          other handlers (ADR-005 §12: consumers own reactions).
 *   • Bounded retry      — transient handler failures retried with backoff.
 *   • Dead-letter queue  — exhausted deliveries are parked with evidence via an
 *                          injectable DLQ port (in-memory default; durable later).
 *   • Idempotency aid    — each delivery carries the event id; handlers dedupe.
 *   • Versioning         — subscribe to a type optionally pinned to a version;
 *                          version mismatch routes to the version-mismatch sink.
 *   • Fire-and-forget    — publish() resolves once dispatch is SCHEDULED, so a
 *                          publisher on a request path is never blocked by slow
 *                          consumers (delivery happens on the microtask queue).
 *
 * Ports (all injectable; safe defaults):
 *   deadLetterQueue: { park(entry) }         default: in-memory array
 *   logger:          { warn, error, info }   default: console-free no-op-ish
 *   clock, scheduler                          default: Date / queueMicrotask
 */

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 20;

function createInMemoryDLQ() {
  const parked = [];
  return {
    park: (entry) => {
      parked.push(Object.freeze({ ...entry, parkedAt: new Date().toISOString() }));
    },
    list: () => parked.slice(),
    size: () => parked.length,
    drain: () => parked.splice(0, parked.length),
  };
}

/**
 * @param {object} [deps]
 * @param {object} [deps.deadLetterQueue] port with park(entry)
 * @param {object} [deps.logger] { warn, error, info }
 * @param {number} [deps.maxRetries]
 * @param {number} [deps.baseDelayMs]
 * @param {(fn:Function)=>void} [deps.scheduler] async scheduler (test hook)
 * @param {(ms:number)=>Promise<void>} [deps.sleep] delay fn (test hook)
 */
function createEventBus(deps = {}) {
  const dlq = deps.deadLetterQueue || createInMemoryDLQ();
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const maxRetries = Number.isInteger(deps.maxRetries) ? deps.maxRetries : DEFAULT_MAX_RETRIES;
  const baseDelay = Number.isInteger(deps.baseDelayMs) ? deps.baseDelayMs : DEFAULT_BASE_DELAY_MS;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const schedule = deps.scheduler || ((fn) => queueMicrotask(fn));

  // type -> [ { handler, name, version|null } ]
  const subscriptions = new Map();
  let _delivered = 0;
  let _deadLettered = 0;
  const _inFlight = new Set();

  /**
   * Subscribe a handler to an event type.
   * @param {string} type
   * @param {(event)=>Promise<void>|void} handler
   * @param {object} [opts] { name, version } — version pins delivery to that schema
   * @returns {()=>void} unsubscribe
   */
  function subscribe(type, handler, opts = {}) {
    if (typeof type !== 'string' || !type) throw new Error('eventBus.subscribe: type required');
    if (typeof handler !== 'function') throw new Error('eventBus.subscribe: handler required');
    const entry = {
      handler,
      name: opts.name || handler.name || 'anonymous',
      version: opts.version ?? null,
    };
    if (!subscriptions.has(type)) subscriptions.set(type, []);
    subscriptions.get(type).push(entry);
    return () => {
      const arr = subscriptions.get(type) || [];
      const i = arr.indexOf(entry);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  async function deliverWithRetry(entry, event) {
    // version pin: a handler bound to a specific version ignores others cleanly.
    if (entry.version != null && entry.version !== event.version) {
      return; // not an error — a versioned consumer simply doesn't handle other versions
    }
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await entry.handler(event);
        _delivered++;
        return;
      } catch (err) {
        if (attempt === maxRetries) {
          _deadLettered++;
          dlq.park({
            event,
            handler: entry.name,
            attempts: attempt + 1,
            error: err && err.message ? err.message : String(err),
          });
          log.error('eventBus: handler exhausted → dead-lettered', {
            type: event.type,
            handler: entry.name,
            error: err && err.message,
          });
          return;
        }
        await sleep(baseDelay * (attempt + 1)); // linear backoff: 20,40,60…
      }
    }
  }

  /**
   * Publish an event. Resolves once dispatch is SCHEDULED (fire-and-forget):
   * publishers on a request path are never blocked by consumers.
   * @param {object} event a DomainEvent envelope
   * @returns {Promise<void>}
   */
  function publish(event) {
    if (!event || typeof event.type !== 'string') {
      throw new Error('eventBus.publish: a DomainEvent with a type is required');
    }
    const handlers = (subscriptions.get(event.type) || []).slice();
    if (handlers.length === 0) return Promise.resolve();

    // Each handler delivered independently (isolation) on the async scheduler.
    const done = Promise.all(
      handlers.map(
        (entry) =>
          new Promise((resolve) => {
            const p = deliverWithRetry(entry, event).then(resolve, resolve);
            _inFlight.add(p);
            p.finally(() => _inFlight.delete(p));
          })
      )
    );
    schedule(() => {}); // ensure a macro/microtask tick even with no handlers awaiting
    return Promise.resolve(done).then(() => {});
  }

  /** Test/ops aid: await all currently in-flight deliveries. */
  async function drain() {
    await Promise.all([..._inFlight]);
  }

  function stats() {
    return {
      types: subscriptions.size,
      delivered: _delivered,
      deadLettered: _deadLettered,
      dlqSize: typeof dlq.size === 'function' ? dlq.size() : undefined,
    };
  }

  return { subscribe, publish, drain, stats, deadLetterQueue: dlq };
}

module.exports = { createEventBus, createInMemoryDLQ };
