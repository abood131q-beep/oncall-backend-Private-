'use strict';

/**
 * SDK ↔ Messaging adapter (Phase 14.5 / ADR-024 §8/§9). Gives an Extension a
 * granted, owner-scoped Messaging port WITHOUT leaking provider internals.
 * Security:
 *   • Topic/namespace isolation — every topic is prefixed with the extension's
 *     namespace (`ext.<owner>.`); an extension can only publish/subscribe within
 *     its own namespace and cannot address another extension's topics.
 *   • Ownership — the prefix is forced; callers cannot escape it.
 *   • Permission — publish/request/broadcast require `messaging:publish`;
 *     subscribe/unsubscribe/reply require `messaging:subscribe`. Missing
 *     capability → PermissionError.
 *   • Correlation validation — reply() only resolves requests the owner issued.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toMessagingPort(
  messaging,
  { owner, canPublish = true, canSubscribe = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toMessagingPort: owner required');
  const prefix = `${namespacePrefix}${owner}.`;
  const scopeTopic = (topic) => {
    if (typeof topic !== 'string' || !topic) throw new PermissionError('messaging: topic required');
    return topic.startsWith(prefix) ? topic : `${prefix}${topic}`;
  };
  const scoped = (spec = {}) => ({ ...spec, topic: scopeTopic(spec.topic) });

  const requirePublish = () => {
    if (!canPublish)
      throw new PermissionError(`extension "${owner}" lacks capability "messaging:publish"`);
  };
  const requireSubscribe = () => {
    if (!canSubscribe)
      throw new PermissionError(`extension "${owner}" lacks capability "messaging:subscribe"`);
  };

  return {
    publish(spec, opts) {
      requirePublish();
      return messaging.publish(scoped(spec), opts);
    },
    broadcast(spec, opts) {
      requirePublish();
      return messaging.broadcast(scoped(spec), opts);
    },
    request(spec, opts) {
      requirePublish();
      return messaging.request(scoped(spec), opts);
    },
    subscribe(spec) {
      requireSubscribe();
      // Group is namespaced too, so competing-consumer groups can't collide across owners.
      const group = spec.group ? `${prefix}${spec.group}` : undefined;
      return messaging.subscribe({ ...spec, topic: scopeTopic(spec.topic), group });
    },
    unsubscribe(id) {
      requireSubscribe();
      return messaging.unsubscribe(id);
    },
    reply(requestMessage, payload) {
      requireSubscribe();
      // Only replies to requests addressed within the owner's namespace.
      if (
        !requestMessage ||
        typeof requestMessage.topic !== 'string' ||
        !requestMessage.topic.startsWith(prefix)
      ) {
        throw new PermissionError(`extension "${owner}" cannot reply outside its namespace`);
      }
      return messaging.reply(requestMessage, payload);
    },
    health() {
      return messaging.health();
    },
  };
}

module.exports = { toMessagingPort };
