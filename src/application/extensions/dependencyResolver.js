'use strict';

/**
 * dependencyResolver (Phase 14.2 §3) — builds the dependency graph over a set of
 * manifests, verifies semver satisfaction + platform/api compatibility, detects
 * cycles, and returns a topological load order. Rejects incompatible sets.
 * Pure (application logic over pure domain); no I/O.
 */

const semver = require('../../domain/extensions/semver');
const { verifyCompatibility } = require('../../domain/extensions/integrity');

/**
 * @param {object[]} manifests validated manifests
 * @param {object} env { platformVersion, platformApiRange }
 * @returns {{ ok:true, order:string[] } | { ok:false, errors:string[] }}
 */
function resolve(manifests, env = {}) {
  const errors = [];
  const byId = new Map();
  for (const m of manifests) {
    if (byId.has(m.id)) errors.push(`duplicate extension id "${m.id}"`);
    byId.set(m.id, m);
  }

  // Compatibility (platform + apiVersion) per extension.
  for (const m of manifests) {
    const c = verifyCompatibility(m, env);
    if (!c.ok) errors.push(`"${m.id}": ${c.problems.join('; ')}`);
  }

  // Dependency existence + version satisfaction.
  for (const m of manifests) {
    for (const [depId, range] of Object.entries(m.dependencies)) {
      const dep = byId.get(depId);
      if (!dep) {
        errors.push(`"${m.id}" depends on missing "${depId}"`);
        continue;
      }
      if (!semver.satisfies(dep.version, range)) {
        errors.push(`"${m.id}" requires ${depId}@${range} but found ${dep.version}`);
      }
    }
  }

  // Cycle detection + topological order (DFS with color marks).
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map([...byId.keys()].map((k) => [k, WHITE]));
  const order = [];
  let cyclePath = null;

  function dfs(id, stack) {
    color.set(id, GRAY);
    const m = byId.get(id);
    for (const depId of Object.keys(m ? m.dependencies : {})) {
      if (!byId.has(depId)) continue; // missing dep already reported
      const c = color.get(depId);
      if (c === GRAY) {
        cyclePath = [...stack, depId].slice(stack.indexOf(depId));
        return true;
      }
      if (c === WHITE && dfs(depId, [...stack, depId])) return true;
    }
    color.set(id, BLACK);
    order.push(id); // deps pushed before dependents ⇒ valid load order
    return false;
  }

  for (const id of byId.keys()) {
    if (color.get(id) === WHITE && dfs(id, [id])) break;
  }
  if (cyclePath) errors.push(`dependency cycle: ${cyclePath.join(' → ')}`);

  if (errors.length) return { ok: false, errors };
  return { ok: true, order };
}

module.exports = { resolve };
