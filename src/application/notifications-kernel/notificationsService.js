'use strict';

/**
 * Notification Service (Phase 15.1 / ADR-030) — the Notification Kernel. Platform-
 * wide, deterministic notification orchestration across delivery channels. This is
 * NOT FCM/APNs/Twilio/SendGrid — those are delivery-provider extension points.
 *
 * Providers DELIVER only; ALL lifecycle logic lives here: deterministic routing +
 * channel selection, template resolution, scheduling, retry handling (deterministic
 * backoff), deduplication, expiration, delivery tracking, failure handling, and
 * status transitions. Lifecycle events flow ONLY through the EventPublisher port.
 * Fully dependency-injected and deterministic (injected clock; tick-driven
 * scheduling — no wall-clock timers). Mutations are atomic per-notification via a
 * serialization mutex.
 */

const { createNotification, fromModel } = require('../../domain/notifications-kernel/notification');
const { resolveContent } = require('../../domain/notifications-kernel/template');
const {
  NOTIFICATION_EVENTS,
  createNotificationEvent,
} = require('../../domain/notifications-kernel/events');
const {
  NotificationValidationError,
  ChannelError,
} = require('../../domain/notifications-kernel/errors');
const { assertProvider } = require('./providerPort');
const { createMemoryStore } = require('./store');
const { createNullPublisher } = require('../shared/eventPublisher');

function createNotificationsService(deps = {}) {
  const store = deps.store || createMemoryStore();
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idOpts = { idFactory: deps.idFactory };

  const _channels = new Map(); // channel name -> { provider, config }
  const _dedup = new Map(); // namespace -> Map(dedupKey -> notificationId)
  const _statusIndex = new Map(); // namespace -> Map(id -> status) — gauges + scans

  function _dedupBucket(ns) {
    if (!_dedup.has(ns)) _dedup.set(ns, new Map());
    return _dedup.get(ns);
  }
  function _indexStatus(ns, id, status) {
    if (!_statusIndex.has(ns)) _statusIndex.set(ns, new Map());
    _statusIndex.get(ns).set(id, status);
  }
  function _countStatus(status) {
    let n = 0;
    for (const m of _statusIndex.values()) for (const s of m.values()) if (s === status) n += 1;
    return n;
  }
  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({ scheduled: () => _countStatus('scheduled') });
  }

  const historyLimit = deps.historyLimit || 500;
  const _lifecycle = [];
  function _recordLifecycle(type, namespace, id) {
    _lifecycle.push({ type, namespace, id, at: clock() });
    if (_lifecycle.length > historyLimit) _lifecycle.shift();
  }
  function _deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      for (const k of Object.keys(o)) _deepFreeze(o[k]);
      Object.freeze(o);
    }
    return o;
  }

  const _locks = new Map();
  function _withLock(key, fn) {
    const prev = _locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    _locks.set(
      key,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  function _emit(type, payload) {
    try {
      const event = createNotificationEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('notifications: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('notifications: could not build event', e.message);
    }
  }

  async function _persist(entity) {
    await store.put(entity.namespace, entity.toModel());
    _indexStatus(entity.namespace, entity.notificationId, entity.status);
  }

  function _dedupKeyOf(entity) {
    return entity.dedupKey != null ? String(entity.dedupKey) : `auto:${entity.checksum}`;
  }

  // ── §1 registerChannel ───────────────────────────────────────────────────────────
  function registerChannel(spec = {}) {
    const name = spec.channel || spec.name;
    if (!name || typeof name !== 'string') {
      throw new NotificationValidationError('notifications: channel name is required');
    }
    const provider = assertProvider(spec.provider);
    if (!provider.supports(name)) {
      log.warn(`notifications: provider "${provider.name}" does not declare support for "${name}"`);
    }
    _channels.set(name, { provider, config: spec.config || {} });
    return { channel: name, provider: provider.name };
  }

  function _resolveChannel(name) {
    const entry = _channels.get(name);
    if (!entry) throw new ChannelError(`notifications: no channel registered for "${name}"`);
    return entry;
  }

  // Create + dedup + persist. Returns { entity, duplicate, existing }.
  async function _create(spec, opts) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const content = resolveContent(spec, spec.data || spec.metadata || {});
    const entity = createNotification(
      {
        ...spec,
        namespace,
        subject: content.subject,
        title: content.title,
        body: content.body,
      },
      { clock, idFactory: idOpts.idFactory }
    );
    const key = _dedupKeyOf(entity);
    const bucket = _dedupBucket(namespace);
    const existingId = bucket.get(key);
    if (existingId) {
      const existing = await store.get(namespace, existingId);
      if (existing && !['delivered', 'cancelled', 'expired', 'failed'].includes(existing.status)) {
        if (metrics) metrics.recordDuplicate();
        return { entity: null, duplicate: true, existing };
      }
    }
    await _persist(entity);
    bucket.set(key, entity.notificationId);
    if (metrics) metrics.recordCreated();
    _recordLifecycle('created', namespace, entity.notificationId);
    _emit(NOTIFICATION_EVENTS.CREATED, {
      notificationId: entity.notificationId,
      namespace,
      channel: entity.channel,
      correlationId: entity.correlationId,
      workflowId: entity.workflowId,
    });
    return { entity, duplicate: false, existing: null };
  }

  // Attempt a single delivery, applying retry / failure / expiration rules.
  async function _deliverNow(entity, now) {
    const namespace = entity.namespace;
    if (entity.isExpired(now)) {
      entity.markExpired(now);
      if (metrics) metrics.recordExpiration();
      await _persist(entity);
      _emit(NOTIFICATION_EVENTS.FAILED, {
        notificationId: entity.notificationId,
        namespace,
        channel: entity.channel,
        reason: 'expired',
      });
      return entity;
    }
    let channelEntry;
    try {
      channelEntry = _resolveChannel(entity.channel);
    } catch (e) {
      entity.markFailed(e.message, now);
      if (metrics) metrics.recordFailure();
      await _persist(entity);
      _emit(NOTIFICATION_EVENTS.FAILED, {
        notificationId: entity.notificationId,
        namespace,
        channel: entity.channel,
        reason: e.message,
        willRetry: false,
      });
      return entity;
    }

    entity.recordAttempt(now);
    entity.markSent(now);
    if (metrics) metrics.recordSent();
    await _persist(entity);
    _emit(NOTIFICATION_EVENTS.SENT, {
      notificationId: entity.notificationId,
      namespace,
      channel: entity.channel,
      attempt: entity.attempts,
    });

    const start = clock();
    let result;
    try {
      result = await channelEntry.provider.deliver(entity.toModel());
    } catch (e) {
      if (metrics) metrics.recordProviderFailure();
      result = { ok: false, reason: e.message };
    }
    if (metrics) metrics.recordLatency(clock() - start);

    if (result && result.ok) {
      entity.markDelivered(result.providerId, now);
      if (metrics) metrics.recordDelivery();
      await _persist(entity);
      _recordLifecycle('delivered', namespace, entity.notificationId);
      _emit(NOTIFICATION_EVENTS.DELIVERED, {
        notificationId: entity.notificationId,
        namespace,
        channel: entity.channel,
        providerId: result.providerId || null,
      });
      return entity;
    }

    const reason = (result && result.reason) || 'delivery failed';
    if (entity.retryPolicy.shouldRetry(entity.attempts)) {
      const delay = entity.retryPolicy.nextDelayMs(entity.attempts);
      entity.scheduleRetry(now + delay, now);
      if (metrics) metrics.recordRetry();
      await _persist(entity);
      _emit(NOTIFICATION_EVENTS.FAILED, {
        notificationId: entity.notificationId,
        namespace,
        channel: entity.channel,
        reason,
        willRetry: true,
        nextAttemptAt: entity.nextAttemptAt,
      });
    } else {
      entity.markFailed(reason, now);
      if (metrics) metrics.recordFailure();
      await _persist(entity);
      _recordLifecycle('failed', namespace, entity.notificationId);
      _emit(NOTIFICATION_EVENTS.FAILED, {
        notificationId: entity.notificationId,
        namespace,
        channel: entity.channel,
        reason,
        willRetry: false,
      });
    }
    return entity;
  }

  // ── §1 send ────────────────────────────────────────────────────────────────────
  function send(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const created = await _create(spec, { namespace });
      if (created.duplicate) return created.existing;
      const id = created.entity.notificationId;
      return _withLock(`${namespace}::${id}`, async () => {
        const now = clock();
        const entity = created.entity;
        return (await _deliverNow(entity, now)).toModel();
      });
    })();
  }

  // ── §1 schedule ──────────────────────────────────────────────────────────────────
  function schedule(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const now = clock();
      const scheduledTime =
        spec.scheduledTime != null
          ? spec.scheduledTime
          : spec.delayMs != null
            ? now + spec.delayMs
            : null;
      if (scheduledTime == null) {
        throw new NotificationValidationError(
          'notifications: schedule requires scheduledTime or delayMs'
        );
      }
      const created = await _create({ ...spec, scheduledTime }, { namespace });
      if (created.duplicate) return created.existing;
      const entity = created.entity;
      entity.markScheduled(now);
      await _persist(entity);
      _recordLifecycle('scheduled', namespace, entity.notificationId);
      _emit(NOTIFICATION_EVENTS.SCHEDULED, {
        notificationId: entity.notificationId,
        namespace,
        channel: entity.channel,
        scheduledTime,
      });
      return entity.toModel();
    })();
  }

  // ── tick: process due scheduled + retrying notifications (deterministic) ──────────
  function tick(nowArg) {
    return (async () => {
      const now = typeof nowArg === 'number' ? nowArg : clock();
      const summary = { processed: 0, delivered: 0, failed: 0, expired: 0 };
      for (const [namespace, statuses] of _statusIndex) {
        for (const [id, status] of statuses) {
          if (status !== 'scheduled') continue;
          const model = await store.get(namespace, id);
          if (!model) continue;
          const due =
            (model.nextAttemptAt != null && model.nextAttemptAt <= now) ||
            (model.nextAttemptAt == null &&
              (model.scheduledTime == null || model.scheduledTime <= now));
          if (!due) continue;
          await _withLock(`${namespace}::${id}`, async () => {
            const fresh = await store.get(namespace, id);
            if (!fresh || fresh.status !== 'scheduled') return;
            const entity = fromModel(fresh, { clock });
            summary.processed += 1;
            await _deliverNow(entity, now);
            if (entity.status === 'delivered') summary.delivered += 1;
            else if (entity.status === 'failed') summary.failed += 1;
            else if (entity.status === 'expired') summary.expired += 1;
          });
        }
      }
      return summary;
    })();
  }

  // ── §1 cancel ────────────────────────────────────────────────────────────────────
  function cancel(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const id = typeof spec === 'string' ? spec : spec.notificationId;
    return _withLock(`${namespace}::${id}`, async () => {
      const model = await store.get(namespace, id);
      if (!model) return false;
      const entity = fromModel(model, { clock });
      if (entity.isTerminal()) return false;
      entity.markCancelled(clock());
      await _persist(entity);
      if (metrics) metrics.recordCancellation();
      _recordLifecycle('cancelled', namespace, id);
      _emit(NOTIFICATION_EVENTS.CANCELLED, {
        notificationId: id,
        namespace,
        channel: entity.channel,
      });
      return true;
    });
  }

  // ── §1 status ──────────────────────────────────────────────────────────────────
  function status(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const id = typeof spec === 'string' ? spec : spec.notificationId;
    return (async () => {
      const model = await store.get(namespace, id);
      return model || null;
    })();
  }

  // ── §1 verify (definition integrity across a namespace) ───────────────────────────
  function verify(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const issues = [];
      const ids = _statusIndex.get(namespace) || new Map();
      for (const id of ids.keys()) {
        const model = await store.get(namespace, id);
        if (!model) {
          issues.push({ notificationId: id, reason: 'missing in store' });
          continue;
        }
        if (!fromModel(model, { clock }).verifyChecksum()) {
          issues.push({ notificationId: id, reason: 'checksum mismatch' });
        }
      }
      return { ok: issues.length === 0, issues };
    })();
  }

  async function health() {
    const channels = [];
    let ok = true;
    for (const [name, entry] of _channels) {
      const h = await entry.provider.health();
      channels.push({ channel: name, provider: entry.provider.name, health: h });
      if (!h || !h.ok) ok = false;
    }
    return {
      ok,
      channels,
      notifications: _countAll(),
      scheduled: _countStatus('scheduled'),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  function _countAll() {
    let n = 0;
    for (const m of _statusIndex.values()) n += m.size;
    return n;
  }

  // ── additive helpers ──────────────────────────────────────────────────────────────
  function list(opts = {}) {
    const namespace = opts.namespace || 'default';
    return store.list(namespace);
  }
  async function snapshotNotification(namespace, id) {
    const m = await store.get(namespace, id);
    return m ? _deepFreeze(m) : null;
  }
  function diagnostics(namespace = 'default') {
    return {
      notifications: (_statusIndex.get(namespace) || new Map()).size,
      total: _countAll(),
      scheduled: _countStatus('scheduled'),
      delivered: _countStatus('delivered'),
      failed: _countStatus('failed'),
      channels: [..._channels.keys()],
      namespaces: _statusIndex.size,
      metrics: metrics ? metrics.snapshot() : null,
    };
  }
  const history = () => _lifecycle.map((h) => ({ ...h }));

  return {
    registerChannel,
    send,
    schedule,
    cancel,
    status,
    verify,
    health,
    // additive helpers
    tick,
    list,
    snapshotNotification,
    diagnostics,
    history,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createNotificationsService };
