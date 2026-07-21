'use strict';

/**
 * Notification (Phase 15.1 / ADR-030 §2) — PURE domain value object. A
 * provider-agnostic, deterministic notification with a lifecycle status, a content
 * checksum for integrity, and a retry policy. This is NOT FCM/APNs/Twilio/SendGrid
 * — those are delivery-provider extension points. Behavior (routing, scheduling,
 * retry, dedup, expiration) lives in the engine; this object owns identity,
 * content, and status transitions.
 *
 * Fields: notificationId, namespace, channel, recipient, template, subject, title,
 * body, priority, status, correlationId, workflowId, metadata, scheduledTime,
 * expirationTime, retryPolicy, attempts, deliveries, createdAt, updatedAt, version,
 * checksum.
 */

const { NotificationValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');
const { createRetryPolicy, policyFromModel } = require('./retryPolicy');

const STATUS = Object.freeze({
  CREATED: 'created',
  SCHEDULED: 'scheduled',
  SENT: 'sent',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

const TERMINAL = new Set([STATUS.DELIVERED, STATUS.CANCELLED, STATUS.EXPIRED]);

const PRIORITY = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  CRITICAL: 'critical',
});

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `ntf_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function definitionOf(n) {
  return {
    namespace: n.namespace,
    channel: n.channel,
    recipient: n.recipient,
    template: n.template,
    subject: n.subject,
    title: n.title,
    body: n.body,
    priority: n.priority,
    correlationId: n.correlationId,
    workflowId: n.workflowId,
    metadata: n.metadata,
    scheduledTime: n.scheduledTime,
    expirationTime: n.expirationTime,
    retryPolicy: n.retryPolicy,
    dedupKey: n.dedupKey,
  };
}

function computeChecksum(n) {
  return checksum(stableStringify(definitionOf(n)));
}

/**
 * @param {object} spec { channel (required), recipient (required), namespace?,
 *   template?, subject?, title?, body?, priority?, correlationId?, workflowId?,
 *   metadata?, scheduledTime?, expirationTime?, retryPolicy?, dedupKey?,
 *   notificationId?, status?, version? }
 * @param {object} [opts] { idFactory, clock }
 */
function createNotification(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  if (!spec.channel || typeof spec.channel !== 'string') {
    throw new NotificationValidationError('notification: "channel" is required');
  }
  if (spec.recipient == null || spec.recipient === '') {
    throw new NotificationValidationError('notification: "recipient" is required');
  }
  const now = clock();
  const rp = spec.retryPolicy
    ? policyFromModel(
        typeof spec.retryPolicy.toModel === 'function'
          ? spec.retryPolicy.toModel()
          : spec.retryPolicy
      )
    : createRetryPolicy({});
  const n = {
    notificationId: spec.notificationId || idFactory(),
    namespace: spec.namespace || 'default',
    channel: spec.channel,
    recipient: spec.recipient,
    template: spec.template != null ? spec.template : null,
    subject: spec.subject != null ? spec.subject : null,
    title: spec.title != null ? spec.title : null,
    body: spec.body != null ? spec.body : null,
    priority: Object.values(PRIORITY).includes(spec.priority) ? spec.priority : PRIORITY.NORMAL,
    status: Object.values(STATUS).includes(spec.status) ? spec.status : STATUS.CREATED,
    correlationId: spec.correlationId != null ? spec.correlationId : null,
    workflowId: spec.workflowId != null ? spec.workflowId : null,
    metadata: { ...(spec.metadata || {}) },
    scheduledTime: spec.scheduledTime != null ? spec.scheduledTime : null,
    expirationTime: spec.expirationTime != null ? spec.expirationTime : null,
    retryPolicy: rp,
    dedupKey: spec.dedupKey != null ? spec.dedupKey : null,
    attempts: spec.attempts || 0,
    nextAttemptAt: spec.nextAttemptAt != null ? spec.nextAttemptAt : null,
    lastError: spec.lastError != null ? spec.lastError : null,
    deliveries: Array.isArray(spec.deliveries) ? [...spec.deliveries] : [],
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,
    version: spec.version || 1,

    isTerminal() {
      return TERMINAL.has(this.status);
    },
    isExpired(nowMs) {
      return this.expirationTime != null && this.expirationTime <= nowMs;
    },
    computeChecksum() {
      return computeChecksum(this);
    },
    verifyChecksum() {
      return this.checksum === computeChecksum(this);
    },
    _touch(nowMs) {
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      this.version += 1;
      return this;
    },
    markScheduled(nowMs) {
      this.status = STATUS.SCHEDULED;
      return this._touch(nowMs);
    },
    recordAttempt(nowMs) {
      this.attempts += 1;
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      return this;
    },
    markSent(nowMs) {
      this.status = STATUS.SENT;
      return this._touch(nowMs);
    },
    markDelivered(providerId, nowMs) {
      this.status = STATUS.DELIVERED;
      this.deliveries.push({
        providerId: providerId || null,
        at: typeof nowMs === 'number' ? nowMs : clock(),
      });
      this.lastError = null;
      return this._touch(nowMs);
    },
    markFailed(reason, nowMs) {
      this.status = STATUS.FAILED;
      this.lastError = reason || 'delivery failed';
      return this._touch(nowMs);
    },
    scheduleRetry(nextAt, nowMs) {
      this.status = STATUS.SCHEDULED;
      this.nextAttemptAt = nextAt;
      return this._touch(nowMs);
    },
    markCancelled(nowMs) {
      this.status = STATUS.CANCELLED;
      return this._touch(nowMs);
    },
    markExpired(nowMs) {
      this.status = STATUS.EXPIRED;
      return this._touch(nowMs);
    },
    toModel() {
      return {
        notificationId: this.notificationId,
        namespace: this.namespace,
        channel: this.channel,
        recipient: this.recipient,
        template: this.template,
        subject: this.subject,
        title: this.title,
        body: this.body,
        priority: this.priority,
        status: this.status,
        correlationId: this.correlationId,
        workflowId: this.workflowId,
        metadata: { ...this.metadata },
        scheduledTime: this.scheduledTime,
        expirationTime: this.expirationTime,
        retryPolicy: this.retryPolicy.toModel(),
        dedupKey: this.dedupKey,
        attempts: this.attempts,
        nextAttemptAt: this.nextAttemptAt,
        lastError: this.lastError,
        deliveries: this.deliveries.map((d) => ({ ...d })),
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        version: this.version,
        checksum: this.checksum,
      };
    },
    /** Public view — notifications are operational records, not secrets. */
    toPublic() {
      return this.toModel();
    },
  };
  n.checksum = spec.checksum || computeChecksum(n);
  return n;
}

function fromModel(model, opts = {}) {
  const n = createNotification(model, opts);
  n.createdAt = model.createdAt;
  n.updatedAt = model.updatedAt;
  n.version = model.version;
  n.status = model.status;
  n.attempts = model.attempts || 0;
  n.checksum = model.checksum != null ? model.checksum : computeChecksum(n);
  return n;
}

module.exports = {
  createNotification,
  fromModel,
  computeChecksum,
  stableStringify,
  STATUS,
  PRIORITY,
  TERMINAL,
};
