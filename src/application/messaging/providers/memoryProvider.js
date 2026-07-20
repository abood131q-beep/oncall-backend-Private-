'use strict';

/**
 * Memory messaging provider (Phase 14.5 / ADR-024 §4) — in-process transport.
 * Single-process only (NOT a broker). Owns the subscriber registry and the
 * fan-out/group selection primitives; the service layers delivery-model policy,
 * retry, TTL, DLQ, events, and metrics on top.
 *
 * Group semantics: within a group, ONE member receives each routed message
 * (competing consumers, round-robin); each distinct group receives a copy
 * (pub/sub). `broadcast` ignores groups and delivers to everyone.
 */

let _sid = 0;

function createMemoryProvider(opts = {}) {
  const byTopic = new Map(); // topic -> Map(id -> { id, topic, group, handler })
  const cursors = new Map(); // `${topic}::${group}` -> round-robin index

  const bucket = (topic) => {
    if (!byTopic.has(topic)) byTopic.set(topic, new Map());
    return byTopic.get(topic);
  };

  function subscribe(topic, handler, { group, id } = {}) {
    if (typeof handler !== 'function')
      throw new Error('memoryProvider: handler must be a function');
    const subId = id || `sub_${(_sid = (_sid + 1) % 1e9)}`;
    const grp = group || `__solo__:${subId}`; // default: each subscriber its own group (pub/sub)
    bucket(topic).set(subId, { id: subId, topic, group: grp, handler });
    return { id: subId, topic, group: grp };
  }

  function unsubscribe(id) {
    for (const subs of byTopic.values()) {
      if (subs.delete(id)) return true;
    }
    return false;
  }

  function _groups(topic) {
    const subs = byTopic.get(topic);
    const groups = new Map(); // group -> [subs]
    if (!subs) return groups;
    for (const s of subs.values()) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    return groups;
  }

  function _pick(topic, group, members) {
    const key = `${topic}::${group}`;
    const i = (cursors.get(key) || 0) % members.length;
    cursors.set(key, i + 1);
    return members[i];
  }

  /** One member per group (competing consumers) — pub/sub across groups. */
  function select(topic) {
    const out = [];
    for (const [group, members] of _groups(topic)) {
      const s = _pick(topic, group, members);
      out.push({ id: s.id, group: s.group, handler: s.handler });
    }
    return out;
  }

  /** Every subscriber regardless of group (broadcast). */
  function selectAll(topic) {
    const subs = byTopic.get(topic);
    return subs
      ? [...subs.values()].map((s) => ({ id: s.id, group: s.group, handler: s.handler }))
      : [];
  }

  function subscriberCount(topic) {
    if (topic) return byTopic.get(topic) ? byTopic.get(topic).size : 0;
    let n = 0;
    for (const subs of byTopic.values()) n += subs.size;
    return n;
  }

  function health() {
    return { ok: true, provider: 'memory', topics: byTopic.size, subscribers: subscriberCount() };
  }

  return {
    name: opts.name || 'memory',
    subscribe,
    unsubscribe,
    select,
    selectAll,
    subscriberCount,
    health,
  };
}

module.exports = { createMemoryProvider };
