'use strict';

/**
 * Workflow Definition (Phase 14.4 / ADR-023) — PURE domain. A declarative,
 * business-logic-free state machine: named states, event-driven transitions
 * (with optional guard + action), per-state timeouts, and terminal states. The
 * engine interprets this; the definition contains NO orchestration itself.
 *
 * Spec:
 *   {
 *     name, version?,
 *     initial,
 *     states: {
 *       <state>: { terminal?: bool, failure?: bool, onTimeout?: { afterMs, to, event? } }
 *     },
 *     transitions: [
 *       { from, on: <event>, to, guard?(ctx,payload)->bool, action?(ctx,payload)->patch }
 *     ],
 *     metadata?
 *   }
 *
 * Guards/actions are runtime functions kept on the definition (never persisted).
 */

const { DefinitionError } = require('./errors');

const TIMEOUT_EVENT = '__timeout__';

function createDefinition(spec = {}) {
  if (!spec.name || typeof spec.name !== 'string')
    throw new DefinitionError('definition: "name" required');
  const states = spec.states || {};
  const stateNames = Object.keys(states);
  if (stateNames.length === 0) throw new DefinitionError('definition: at least one state required');
  if (!spec.initial || !states[spec.initial]) {
    throw new DefinitionError(`definition: "initial" must be a declared state`);
  }

  const errors = [];
  const index = new Map(); // `${from}::${event}` -> transition
  for (const t of spec.transitions || []) {
    if (!states[t.from]) errors.push(`transition from unknown state "${t.from}"`);
    if (!states[t.to]) errors.push(`transition to unknown state "${t.to}"`);
    if (!t.on) errors.push(`transition ${t.from}->${t.to} missing "on" event`);
    const key = `${t.from}::${t.on}`;
    if (index.has(key)) errors.push(`duplicate transition for (${t.from}, ${t.on})`);
    index.set(
      key,
      Object.freeze({ from: t.from, on: t.on, to: t.to, guard: t.guard, action: t.action })
    );
  }
  // Validate timeout targets.
  for (const [name, s] of Object.entries(states)) {
    if (s.onTimeout) {
      if (typeof s.onTimeout.afterMs !== 'number' || s.onTimeout.afterMs <= 0) {
        errors.push(`state "${name}" onTimeout.afterMs must be a positive number`);
      }
      if (!states[s.onTimeout.to]) errors.push(`state "${name}" onTimeout.to unknown state`);
    }
  }
  if (errors.length) throw new DefinitionError(`definition "${spec.name}" invalid`, { errors });

  const def = {
    name: spec.name,
    version: spec.version || 1,
    initial: spec.initial,
    states,
    metadata: { ...(spec.metadata || {}) },
    key() {
      return `${this.name}@${this.version}`;
    },
    isState(name) {
      return Boolean(states[name]);
    },
    isTerminal(name) {
      return Boolean(states[name] && states[name].terminal);
    },
    isFailureState(name) {
      return Boolean(states[name] && states[name].failure);
    },
    findTransition(from, event) {
      return index.get(`${from}::${event}`) || null;
    },
    timeoutFor(state) {
      const s = states[state];
      return s && s.onTimeout ? s.onTimeout : null;
    },
    /** Structural view (no functions) for docs/telemetry. */
    toModel() {
      return {
        name: this.name,
        version: this.version,
        initial: this.initial,
        states: Object.keys(states),
        transitions: [...index.values()].map((t) => ({ from: t.from, on: t.on, to: t.to })),
      };
    },
  };
  return def;
}

module.exports = { createDefinition, TIMEOUT_EVENT };
