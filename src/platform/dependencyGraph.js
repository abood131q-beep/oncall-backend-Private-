'use strict';

/**
 * Dependency Graph (Phase 16.1 / ADR-042 §4) — PURE, deterministic. Builds the kernel
 * dependency graph from registry descriptors and validates it:
 *   • missing dependencies (a dependsOn/ports target that isn't registered)
 *   • duplicate registrations (defensive; the registry already prevents these)
 *   • circular dependencies (with the offending cycle reported)
 * then produces a deterministic topological STARTUP ordering (dependencies first, ties
 * broken by registration index so the order is stable across runs) and its exact
 * reverse as the SHUTDOWN ordering.
 *
 * `dependsOn` and `ports` both express "must be composed before me": a kernel whose
 * services are injected as another kernel's ports must exist first, so ports edges also
 * constrain ordering.
 */

/** Combined predecessor set for a descriptor (ordering + port edges). */
function edgesOf(descriptor) {
  const set = new Set([...descriptor.dependsOn, ...descriptor.ports]);
  return [...set];
}

function buildDependencyGraph(descriptors) {
  const issues = [];
  const index = new Map(); // name -> registration index
  const byName = new Map();
  const seen = new Set();
  descriptors.forEach((d, i) => {
    if (seen.has(d.name)) {
      issues.push({ kernel: d.name, reason: 'duplicate registration' });
    }
    seen.add(d.name);
    index.set(d.name, i);
    byName.set(d.name, d);
  });

  // Missing dependency / port validation.
  for (const d of descriptors) {
    for (const dep of edgesOf(d)) {
      if (!byName.has(dep)) {
        issues.push({ kernel: d.name, reason: 'missing dependency', dependency: dep });
      }
    }
  }

  // Deterministic Kahn topological sort. Ready nodes are chosen by lowest registration
  // index, so the resulting order is stable and reproducible.
  const indeg = new Map();
  const adj = new Map(); // dep -> [dependents]
  for (const d of descriptors) {
    indeg.set(d.name, 0);
    adj.set(d.name, []);
  }
  for (const d of descriptors) {
    for (const dep of edgesOf(d)) {
      if (!byName.has(dep)) continue; // already reported as missing
      indeg.set(d.name, indeg.get(d.name) + 1);
      adj.get(dep).push(d.name);
    }
  }

  const order = [];
  const ready = descriptors
    .filter((d) => indeg.get(d.name) === 0)
    .map((d) => d.name)
    .sort((a, b) => index.get(a) - index.get(b));
  while (ready.length) {
    const name = ready.shift();
    order.push(name);
    for (const dependent of adj.get(name)) {
      indeg.set(dependent, indeg.get(dependent) - 1);
      if (indeg.get(dependent) === 0) {
        // insert keeping the ready list sorted by registration index (deterministic)
        const idx = index.get(dependent);
        let lo = 0;
        while (lo < ready.length && index.get(ready[lo]) < idx) lo += 1;
        ready.splice(lo, 0, dependent);
      }
    }
  }

  let cycle = null;
  if (order.length !== descriptors.length) {
    // Nodes never reaching indegree 0 are part of (or downstream of) a cycle.
    const remaining = descriptors.map((d) => d.name).filter((n) => !order.includes(n));
    cycle = detectCycle(remaining, byName);
    issues.push({ reason: 'circular dependency', cycle: cycle || remaining });
  }

  const ok = issues.length === 0;
  return {
    ok,
    order: ok ? order : [],
    shutdownOrder: ok ? [...order].reverse() : [],
    issues,
    cycle,
  };
}

/** Find one concrete cycle among the remaining nodes via DFS (for diagnostics). */
function detectCycle(remaining, byName) {
  const inSet = new Set(remaining);
  const state = new Map(); // 0 = unvisited, 1 = on-stack, 2 = done
  const stack = [];
  let found = null;

  function dfs(node) {
    if (found) return;
    state.set(node, 1);
    stack.push(node);
    const d = byName.get(node);
    for (const dep of new Set([...d.dependsOn, ...d.ports])) {
      if (!inSet.has(dep)) continue;
      const s = state.get(dep) || 0;
      if (s === 1) {
        const start = stack.indexOf(dep);
        found = stack.slice(start).concat(dep);
        return;
      }
      if (s === 0) dfs(dep);
      if (found) return;
    }
    stack.pop();
    state.set(node, 2);
  }

  for (const node of remaining) {
    if ((state.get(node) || 0) === 0) dfs(node);
    if (found) break;
  }
  return found;
}

module.exports = { buildDependencyGraph, detectCycle, edgesOf };
