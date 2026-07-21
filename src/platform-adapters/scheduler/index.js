'use strict';

/**
 * Scheduler Adapter — Phase 17.6.
 *
 * The ONLY component permitted to talk to the Scheduler Kernel (ADR-020). It is a pure
 * TRANSLATION layer between the legacy schedule descriptor and the kernel's public service
 * (`scheduleRecurring / scheduleAt / jobSnapshot`). It contains NO business logic and never
 * touches repositories, the database, or application services.
 *
 * SHADOW / NON-OWNERSHIP POSTURE: the Scheduler Kernel can arm a REAL timer via `start()` and
 * execute due work via `tick()`. This adapter calls NEITHER. It only *registers* a schedule
 * (computing its plan/next-run) and reads it back, so:
 *   • the kernel never owns a timer and never executes anything;
 *   • scheduling ownership and timing stay entirely with the legacy scheduler;
 *   • the kernel is never authoritative and its view is never returned to the application.
 *
 * Round-trip: the full legacy descriptor rides on the job `metadata` (serializable ⇒ lossless);
 * the schedule identity (`name`/`owner`), `scheduleType` (interval/once), and lifecycle
 * `status` are additionally verified natively — proving the kernel represented the schedule in
 * a NON-running state without arming a timer.
 */

const { requirePort } = require('../_base');

/** A handler that is stored but never invoked (the adapter never starts/ticks the scheduler). */
const NOOP_HANDLER = async () => undefined;

/** The kernel scheduleType a descriptor maps to (interval jobs recur; startup runs once). */
function expectedScheduleType(kind) {
  return kind === 'startup' ? 'once' : 'interval';
}

/** Encode a legacy schedule descriptor into a kernel jobSpec (pure). */
function toKernelSpec(descriptor = {}) {
  return {
    name: String(descriptor.id),
    owner: String(descriptor.owner || 'oncall'),
    kind: descriptor.kind || 'interval',
    intervalMs: Number(descriptor.intervalMs) || 0,
    metadata: { payload: { ...descriptor } }, // full descriptor, serializable ⇒ lossless
  };
}

/** Decode a kernel job model back into the comparable shape (pure). */
function fromKernelModel(model = {}) {
  const meta = model.metadata || {};
  return {
    descriptor: meta.payload || null,
    kernel: {
      name: model.name,
      owner: model.owner,
      scheduleType: model.scheduleType,
      status: model.status,
    },
  };
}

function createSchedulerAdapter({ port = null } = {}) {
  return Object.freeze({
    name: 'scheduler',
    kernel: 'scheduler (ADR-020)',
    consumed: () => port != null,

    // ── pure translation (shape-only) ───────────────────────────────────────────
    toKernelSpec,
    fromKernelModel,
    expectedScheduleType,

    // ── active reads/writes (require an injected Scheduler kernel port) ──────────
    /**
     * Register a legacy schedule into the kernel WITHOUT arming a timer or executing it, and
     * return its jobId. Uses scheduleRecurring (interval) or scheduleAt (startup/once). NEVER
     * calls start() or tick().
     */
    async record(descriptor) {
      const p = requirePort('scheduler', port);
      const spec = toKernelSpec(descriptor);
      const jobSpec = {
        name: spec.name,
        owner: spec.owner,
        handler: NOOP_HANDLER,
        metadata: spec.metadata,
      };
      const jobId =
        spec.kind === 'startup'
          ? p.scheduleAt(jobSpec, Date.now()) // once (never ticked ⇒ never runs)
          : p.scheduleRecurring(jobSpec, { intervalMs: spec.intervalMs });
      return { jobId };
    },
    /** Generic round-trip contract: read the placed schedule back, decoded. */
    async readRef(ref) {
      const p = requirePort('scheduler', port);
      const model = p.jobSnapshot(ref.jobId);
      return model ? fromKernelModel(model) : null;
    },

    health: () => ({ ok: true, consumed: port != null }),
  });
}

module.exports = { createSchedulerAdapter, toKernelSpec, fromKernelModel, expectedScheduleType };
