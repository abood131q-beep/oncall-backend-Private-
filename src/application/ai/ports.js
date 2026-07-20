'use strict';

/**
 * AI / Automation ports — capability contracts the Application depends on
 * (ADR-005 §2). Infrastructure implements. Every port reflects an EXISTING
 * integration or the current (disabled) posture; none introduces a new runtime.
 *
 * aiProvider:               isConfigured, infer   (disabled today — infer is
 *                           never invoked while no model provider is enabled)
 * promptRepository:         get                    (authored prompt templates —
 *                           none authored today → returns null)
 * aiConfigurationRepository: getConfig             (AI config from env — disabled)
 * aiAuditRepository:        record                 (routes to the existing logger
 *                           audit fabric, ADR-007/ADR-011 §4)
 */

const PORT_SHAPES = {
  aiProvider: ['isConfigured', 'infer'],
  promptRepository: ['get'],
  aiConfigurationRepository: ['getConfig'],
  aiAuditRepository: ['record'],
};

function assertPorts(ports) {
  for (const [name, methods] of Object.entries(PORT_SHAPES)) {
    if (!ports[name]) throw new Error(`AI ports: missing port "${name}"`);
    for (const m of methods) {
      if (typeof ports[name][m] !== 'function') {
        throw new Error(`AI ports: port "${name}" missing method "${m}"`);
      }
    }
  }
  return ports;
}

module.exports = { assertPorts, PORT_SHAPES };
