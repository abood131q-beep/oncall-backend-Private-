'use strict';

/**
 * Audit Record (Phase 14.7 / ADR-026 §2/§3) — PURE domain value object. An
 * IMMUTABLE, append-only entry recording a significant business/platform event
 * for traceability, compliance, and forensics. NOT an application log line.
 *
 * Integrity: each record carries a `checksum` (sha256 over its content + the
 * previous record's checksum), forming a tamper-evident HASH CHAIN per namespace.
 * The frozen envelope cannot be mutated after creation.
 *
 * Fields: auditId, timestamp, actor, subject, action, resource, category,
 * severity, correlationId, conversationId, workflowId, messageId, metadata,
 * sequence, prevChecksum, checksum, version.
 */

const { AuditValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');

const SEVERITY = Object.freeze(['info', 'notice', 'warning', 'critical']);
const GENESIS = '0'.repeat(64); // prevChecksum for the first record in a chain

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `aud_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

/** The canonical, deterministic content hashed into the checksum. */
function _content(rec) {
  return JSON.stringify({
    auditId: rec.auditId,
    timestamp: rec.timestamp,
    actor: rec.actor,
    subject: rec.subject,
    action: rec.action,
    resource: rec.resource,
    category: rec.category,
    severity: rec.severity,
    correlationId: rec.correlationId,
    conversationId: rec.conversationId,
    workflowId: rec.workflowId,
    messageId: rec.messageId,
    metadata: rec.metadata,
    sequence: rec.sequence,
    prevChecksum: rec.prevChecksum,
    version: rec.version,
  });
}

/**
 * @param {object} spec { action (required), actor?, subject?, resource?, category?,
 *   severity?, correlationId?, conversationId?, workflowId?, messageId?, metadata? }
 * @param {object} chain { sequence, prevChecksum }
 * @param {object} [opts] { clock, idFactory }
 */
function createRecord(spec = {}, chain = {}, opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const idFactory = opts.idFactory || defaultId;
  if (!spec.action || typeof spec.action !== 'string') {
    throw new AuditValidationError('audit: "action" is required');
  }
  const severity = spec.severity && SEVERITY.includes(spec.severity) ? spec.severity : 'info';
  const base = {
    auditId: spec.auditId || idFactory(),
    timestamp: typeof spec.timestamp === 'number' ? spec.timestamp : clock(),
    actor: spec.actor || null,
    subject: spec.subject || null,
    action: spec.action,
    resource: spec.resource || null,
    category: spec.category || 'general',
    severity,
    correlationId: spec.correlationId || null,
    conversationId: spec.conversationId || null,
    workflowId: spec.workflowId || null,
    messageId: spec.messageId || null,
    metadata: { ...(spec.metadata || {}) },
    sequence: Number.isInteger(chain.sequence) ? chain.sequence : 0,
    prevChecksum: chain.prevChecksum || GENESIS,
    version: spec.version || 1,
  };
  base.checksum = checksum(_content(base));
  // Immutable: freeze the whole envelope (metadata included).
  Object.freeze(base.metadata);
  return Object.freeze(base);
}

/** Recompute a record's checksum and compare — detects content tampering. */
function verifyChecksum(rec) {
  return rec && rec.checksum === checksum(_content(rec));
}

module.exports = { createRecord, verifyChecksum, SEVERITY, GENESIS };
