'use strict';

/**
 * Configuration precedence (Phase 14.3.2 §3) — PURE domain.
 *
 * Deterministic layered resolution. Given the same layer inputs, `resolve` and
 * `resolveKey` ALWAYS produce the same result (no I/O, no clock, no globals).
 *
 * Highest priority first:
 *   runtime → tenant → organization → environment → provider → file → default
 *
 * A layer is a plain map of `{ key: value }`. Missing layers are treated as
 * empty. Precedence is by layer order only; within a layer the last writer of a
 * key already won at ingestion time.
 */

// Ordered high→low. The resolver walks this order and the first hit wins.
const LAYERS = Object.freeze([
  'runtime',
  'tenant',
  'organization',
  'environment',
  'provider',
  'file',
  'default',
]);

const LAYER_SET = new Set(LAYERS);

function isKnownLayer(name) {
  return LAYER_SET.has(name);
}

/**
 * Resolve a single key across layers.
 * @param {string} key
 * @param {object} layers { runtime?, tenant?, organization?, environment?, provider?, file?, default? }
 * @returns {{ found: boolean, value: any, layer: string|null }}
 */
function resolveKey(key, layers = {}) {
  for (const layer of LAYERS) {
    const bag = layers[layer];
    if (bag && Object.prototype.hasOwnProperty.call(bag, key)) {
      return { found: true, value: bag[key], layer };
    }
  }
  return { found: false, value: undefined, layer: null };
}

/**
 * Resolve the full effective configuration: the union of all keys across layers,
 * each taking its highest-priority value. Deterministic key ordering (sorted).
 * @param {object} layers
 * @returns {{ values: object, origins: object }} origins maps key → winning layer
 */
function resolve(layers = {}) {
  const keys = new Set();
  for (const layer of LAYERS) {
    const bag = layers[layer];
    if (bag) for (const k of Object.keys(bag)) keys.add(k);
  }
  const values = {};
  const origins = {};
  for (const key of [...keys].sort()) {
    const r = resolveKey(key, layers);
    if (r.found) {
      values[key] = r.value;
      origins[key] = r.layer;
    }
  }
  return { values, origins };
}

/**
 * List keys (optionally by prefix) from the resolved values. Deterministic order.
 */
function listKeys(values = {}, prefix) {
  const keys = Object.keys(values).sort();
  if (!prefix) return keys;
  return keys.filter((k) => k.startsWith(prefix));
}

module.exports = { LAYERS, isKnownLayer, resolveKey, resolve, listKeys };
