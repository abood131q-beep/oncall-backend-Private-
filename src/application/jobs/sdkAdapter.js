'use strict';

/**
 * SDK ↔ Background Jobs adapter (Phase 15.3 / ADR-032 §7/§9). Gives an Extension a
 * granted, namespace-isolated Jobs port WITHOUT leaking engine internals or the
 * ability to register handlers. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`); it cannot enqueue into or read another
 *     extension's jobs.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — enqueue/schedule/cancel require `jobs:enqueue`; status/verify
 *     require `jobs:read`. Missing capability → PermissionError.
 *   • Handler registration is NOT exposed — registering executable code is
 *     administrative.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toJobsPort(
  jobs,
  { owner, canEnqueue = true, canRead = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toJobsPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireEnqueue = () => {
    if (!canEnqueue) {
      throw new PermissionError(`extension "${owner}" lacks capability "jobs:enqueue"`);
    }
  };
  const requireRead = () => {
    if (!canRead) throw new PermissionError(`extension "${owner}" lacks capability "jobs:read"`);
  };

  return {
    enqueue(spec = {}) {
      requireEnqueue();
      return jobs.enqueue(spec, { namespace });
    },
    schedule(spec = {}) {
      requireEnqueue();
      return jobs.schedule(spec, { namespace });
    },
    cancel(spec = {}) {
      requireEnqueue();
      return jobs.cancel(spec, { namespace });
    },
    status(spec = {}) {
      requireRead();
      return jobs.status(spec, { namespace });
    },
    verify() {
      requireRead();
      return jobs.verify({ namespace });
    },
    health() {
      return jobs.health();
    },
  };
}

module.exports = { toJobsPort };
