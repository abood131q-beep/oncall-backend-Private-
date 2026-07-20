'use strict';

/**
 * Transactional Outbox (Phase 14.1 review #1) — guarantees an event is published
 * ONLY IF its transaction committed, and (with a durable store) that it is not
 * lost if the process crashes after commit but before publish.
 *
 * The classic hazard this closes: calling `publish()` before the DB commit — if
 * the commit then fails, a phantom event describes reality that never happened.
 *
 * Correct usage pattern (documented + enforced by shape):
 *
 *   const uow = outbox.begin();
 *   await dbTransaction(async () => {
 *     await repo.doWork(...);         // business writes
 *     uow.stage(event);              // stage event IN THE SAME unit of work
 *     await uow.persist(txRunner);   // (durable adapter) write to outbox table
 *   });                              // ── COMMIT boundary ──
 *   await uow.relay();               // publish staged events AFTER commit
 *
 * If the transaction throws, `relay()` is never reached and staged events are
 * discarded → no phantom events. With a durable outbox table, a background
 * relay re-publishes any committed-but-unrelayed rows after a crash
 * (at-least-once; consumers dedupe by eventId — review #6).
 *
 * Ports:
 *   publisher: EventPublisher (publish)
 *   persistence (optional, durable): { save(events, txRunner), markRelayed(ids),
 *                                      loadUnrelayed() } — in-memory default no-ops
 */

function createInMemoryOutboxStore() {
  const rows = []; // { event, relayed }
  return {
    save(events) {
      for (const e of events) rows.push({ event: e, relayed: false });
      return Promise.resolve();
    },
    markRelayed(ids) {
      const set = new Set(ids);
      for (const r of rows) if (set.has(r.event.id)) r.relayed = true;
      return Promise.resolve();
    },
    loadUnrelayed: () => rows.filter((r) => !r.relayed).map((r) => r.event),
    size: () => rows.length,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.publisher   EventPublisher (publish)
 * @param {object} [deps.store]     durable outbox store (default in-memory)
 * @param {object} [deps.logger]
 */
function createOutbox(deps) {
  if (!deps || !deps.publisher || typeof deps.publisher.publish !== 'function') {
    throw new Error('createOutbox: an EventPublisher (with publish) is required');
  }
  const publisher = deps.publisher;
  const store = deps.store || createInMemoryOutboxStore();
  const log = deps.logger || { warn() {}, error() {}, info() {} };

  /** Begin a unit of work: stage events, persist within the tx, relay after commit. */
  function begin() {
    const staged = [];
    let committed = false;
    return {
      stage(event) {
        if (!event || !event.id) throw new Error('outbox.stage: DomainEvent with id required');
        staged.push(event);
        return event;
      },
      /** Persist staged events to the durable store INSIDE the caller's transaction. */
      async persist(txRunner) {
        await store.save(staged, txRunner);
        committed = true; // the caller's dbTransaction will commit these rows atomically
      },
      /** Publish staged events AFTER the transaction committed. */
      async relay() {
        // If persist() was never called (no durable store used), relay the staged
        // set directly — still only reached when the surrounding tx did not throw.
        const toRelay = staged;
        const relayedIds = [];
        for (const e of toRelay) {
          try {
            await publisher.publish(e);
            relayedIds.push(e.id);
          } catch (err) {
            log.error('outbox.relay: publish failed (will remain unrelayed)', {
              type: e.type,
              id: e.id,
              error: err && err.message,
            });
          }
        }
        if (committed && relayedIds.length) await store.markRelayed(relayedIds);
        return relayedIds;
      },
      staged: () => staged.slice(),
    };
  }

  /** Background relay: re-publish any committed-but-unrelayed events (crash recovery). */
  async function relayPending() {
    const pending = store.loadUnrelayed();
    const relayedIds = [];
    for (const e of pending) {
      try {
        await publisher.publish(e);
        relayedIds.push(e.id);
      } catch (err) {
        log.error('outbox.relayPending: publish failed', { id: e.id, error: err && err.message });
      }
    }
    if (relayedIds.length) await store.markRelayed(relayedIds);
    return relayedIds;
  }

  return { begin, relayPending, store };
}

module.exports = { createOutbox, createInMemoryOutboxStore };
