'use strict';

/**
 * StorageRecord (Phase 14.3.4 §2) — PURE domain value object. The unit every
 * provider persists, independent of any database. Supports documents,
 * key-value, and binary objects (via `value` + `contentType`), metadata,
 * versioning, optimistic concurrency (monotonic `version`), TTL, namespaces,
 * and collections. No business logic.
 *
 * Envelope:
 *   { namespace, collection, key, value, contentType, metadata,
 *     version, createdAt, updatedAt, expiresAt }
 */

const { ValidationError } = require('./errors');

const KIND = Object.freeze({ DOCUMENT: 'document', KV: 'kv', BINARY: 'binary' });

function isBinary(value) {
  return (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) || value instanceof Uint8Array;
}

function inferContentType(value, explicit) {
  if (explicit) return explicit;
  if (isBinary(value)) return 'application/octet-stream';
  if (value !== null && typeof value === 'object') return 'application/json';
  return 'text/plain';
}

/**
 * @param {object} spec { namespace, collection, key, value, contentType?, metadata?, ttlMs? }
 * @param {object} [opts] { clock: () => msEpoch }
 */
function createRecord(spec = {}, opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const now = clock();
  if (!spec.namespace || typeof spec.namespace !== 'string') {
    throw new ValidationError('record: "namespace" is required');
  }
  if (!spec.key || typeof spec.key !== 'string') {
    throw new ValidationError('record: "key" is required');
  }
  const ttlMs = typeof spec.ttlMs === 'number' && spec.ttlMs > 0 ? spec.ttlMs : null;
  return {
    namespace: spec.namespace,
    collection: spec.collection || 'default',
    key: spec.key,
    value: spec.value === undefined ? null : spec.value,
    contentType: inferContentType(spec.value, spec.contentType),
    metadata: { ...(spec.metadata || {}) },
    version: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: ttlMs ? now + ttlMs : null,
  };
}

/** Produce the next version of a record (immutably) after a value/metadata change. */
function bumpVersion(record, patch = {}, opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const now = clock();
  const value = patch.value === undefined ? record.value : patch.value;
  const ttlMs = typeof patch.ttlMs === 'number' && patch.ttlMs > 0 ? patch.ttlMs : null;
  return {
    ...record,
    value,
    contentType: inferContentType(value, patch.contentType || record.contentType),
    metadata: patch.metadata ? { ...record.metadata, ...patch.metadata } : record.metadata,
    version: record.version + 1,
    updatedAt: now,
    expiresAt: ttlMs ? now + ttlMs : patch.clearTtl ? null : record.expiresAt,
  };
}

function isExpired(record, now) {
  return Boolean(record && record.expiresAt != null && record.expiresAt <= now);
}

/** Public, serializable view (safe copy). */
function toModel(record) {
  return {
    namespace: record.namespace,
    collection: record.collection,
    key: record.key,
    value: record.value,
    contentType: record.contentType,
    metadata: { ...record.metadata },
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
  };
}

module.exports = { createRecord, bumpVersion, isExpired, toModel, isBinary, KIND };
