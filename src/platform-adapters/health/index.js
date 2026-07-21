'use strict';

/**
 * Health Adapter — translates the application's health snapshot into the Host/Runtime
 * `{ ok, ... }` health contract, and vice-versa. This is a PURE translator (no kernel
 * consumption) and is the one adapter OnCallAppService may use to shape its own health()
 * output for the Host — it never reaches into a kernel.
 */

function createHealthAdapter() {
  return Object.freeze({
    name: 'health',
    kernel: 'observability/host health contract',
    consumed: () => false,
    // pure translation: app checks {db:'ok', ...} → host health { ok, checks }
    toHostHealth: (snapshot = {}) => {
      const checks = { ...snapshot };
      const values = Object.values(checks).map((v) =>
        typeof v === 'string' ? v : v && v.status ? v.status : v
      );
      const ok = !values.includes('error') && !values.includes('down') && !values.includes(false);
      return { ok, checks };
    },
    // pure translation: readiness boolean → host readiness slice
    toReadiness: (ready) => ({ ready: Boolean(ready) }),
    health: () => ({ ok: true, consumed: false }),
  });
}

module.exports = { createHealthAdapter };
