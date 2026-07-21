'use strict';

/**
 * Jobs Adapter — Phase 17.5.
 *
 * The ONLY component permitted to talk to the Background Jobs Kernel (ADR-032). It is a pure
 * TRANSLATION layer between the legacy background-job descriptor and the kernel's public
 * service (`register / enqueue / schedule / status`). It contains NO business logic and never
 * touches repositories, the database, or application services.
 *
 * SHADOW / NON-EXECUTION POSTURE: the Jobs Kernel is tick-driven — a job executes ONLY when
 * `tick(now)` is called. This adapter NEVER calls `tick()`. It registers a NO-OP handler and
 * places a job definition into the kernel (as `scheduled`, or `queued` for a startup one-shot)
 * purely so the shadow can read it back and compare. Therefore:
 *   • no production job is ever executed;
 *   • execution ownership and timing stay entirely with the legacy scheduler;
 *   • the kernel is never authoritative and its view is never returned to the application.
 *
 * Round-trip: the full legacy descriptor rides on the job `payload` (serializable ⇒ lossless);
 * the job identity (`type`) and lifecycle `status` are additionally verified natively, proving
 * the kernel represented the job in a NON-running state without executing it.
 */

const { requirePort } = require('../_base');

/** A handler that is stored but never invoked (the shadow never ticks the kernel). */
const NOOP_HANDLER = async () => undefined;

/** The kernel lifecycle status a descriptor should map to (proves non-execution). */
function expectedStatus(kind) {
  return kind === 'startup' ? 'queued' : 'scheduled';
}

/** Encode a legacy job descriptor into a kernel register/schedule spec (pure). */
function toKernelSpec(descriptor = {}) {
  return {
    type: String(descriptor.id),
    kind: descriptor.kind || 'interval',
    delayMs: Number(descriptor.intervalMs) || 0,
    payload: { ...descriptor }, // full descriptor, serializable ⇒ lossless round-trip
  };
}

/** Decode a kernel job model back into the comparable shape (pure). */
function fromKernelModel(model = {}) {
  return {
    descriptor: model.payload || null,
    kernel: { type: model.type, status: model.status },
  };
}

function createJobsAdapter({ port = null, namespacePrefix = 'jobs-shadow' } = {}) {
  let seq = 0;

  return Object.freeze({
    name: 'jobs',
    kernel: 'jobs (ADR-032)',
    consumed: () => port != null,

    // ── pure translation (shape-only) ───────────────────────────────────────────
    toKernelSpec,
    fromKernelModel,
    expectedStatus,
    /** A fresh, isolated namespace per shadow pass (prevents cross-pass accumulation). */
    nextNamespace: () => `${namespacePrefix}-${++seq}`,

    // ── active reads/writes (require an injected Jobs kernel port) ───────────────
    /**
     * Place a legacy job DEFINITION into the kernel WITHOUT executing it, and return its
     * jobId. Registers a no-op handler, then schedules (interval) or enqueues (startup).
     * NEVER calls tick(), so no handler ever runs.
     */
    async record(descriptor, namespace) {
      const p = requirePort('jobs', port);
      const spec = toKernelSpec(descriptor);
      p.register({ type: spec.type, handler: NOOP_HANDLER });
      const ns = namespace || `${namespacePrefix}-${++seq}`;
      const model =
        spec.kind === 'startup'
          ? await p.enqueue({ type: spec.type, payload: spec.payload }, { namespace: ns })
          : await p.schedule(
              { type: spec.type, delayMs: spec.delayMs, payload: spec.payload },
              { namespace: ns }
            );
      return { jobId: model.jobId, namespace: ns };
    },
    /** Read a placed job back, decoded, for comparison. */
    async readJob(jobId, namespace) {
      const p = requirePort('jobs', port);
      const model = await p.status({ jobId }, { namespace });
      return model ? fromKernelModel(model) : null;
    },
    /** Generic round-trip contract: read back by the ref returned from record(). */
    async readRef(ref) {
      const p = requirePort('jobs', port);
      const model = await p.status({ jobId: ref.jobId }, { namespace: ref.namespace });
      return model ? fromKernelModel(model) : null;
    },

    health: () => ({ ok: true, consumed: port != null }),
  });
}

module.exports = { createJobsAdapter, toKernelSpec, fromKernelModel, expectedStatus };
