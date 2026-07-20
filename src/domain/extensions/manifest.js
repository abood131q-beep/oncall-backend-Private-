'use strict';

/**
 * Extension Manifest (Phase 14.2 §1) — strongly validated descriptor. Pure
 * Domain: no I/O. `validateManifest` returns a normalized frozen manifest or
 * throws a ManifestError listing every problem — invalid manifests are rejected,
 * never partially loaded.
 */

const semver = require('./semver');
const { isKnownCapability, isKnownPermission } = require('./capabilities');
const { isKnownHook } = require('./hooksCatalog');

class ManifestError extends Error {
  constructor(errors) {
    super(`Invalid extension manifest:\n - ${errors.join('\n - ')}`);
    this.name = 'ManifestError';
    this.errors = errors;
  }
}

const ID_RE = /^[a-z][a-z0-9-]{2,63}$/; // lowercase, dash, 3–64 chars

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {object} raw candidate manifest
 * @returns {Readonly<object>} normalized manifest
 * @throws {ManifestError}
 */
function validateManifest(raw) {
  const e = [];
  const m = isPlainObject(raw) ? raw : {};

  // Required string fields
  if (!ID_RE.test(m.id || '')) e.push('id: must match ^[a-z][a-z0-9-]{2,63}$');
  if (typeof m.name !== 'string' || !m.name.trim()) e.push('name: required non-empty string');
  if (!semver.isValid(m.version)) e.push('version: required semver x.y.z');
  if (!semver.isValid(m.apiVersion)) e.push('apiVersion: required semver x.y.z');
  if (typeof m.author !== 'string' || !m.author.trim()) e.push('author: required non-empty string');
  if (typeof m.description !== 'string') e.push('description: required string');
  if (!semver.isValid(m.minimumPlatformVersion))
    e.push('minimumPlatformVersion: required semver x.y.z');

  // permissions[] — closed vocabulary
  const permissions = Array.isArray(m.permissions) ? m.permissions : null;
  if (!permissions) e.push('permissions: required array (may be empty)');
  else {
    const bad = permissions.filter((p) => !isKnownPermission(p));
    if (bad.length) e.push(`permissions: unknown ${JSON.stringify(bad)}`);
  }

  // capabilities[] — closed vocabulary; at least one is recommended, not required
  const capabilities = Array.isArray(m.capabilities) ? m.capabilities : null;
  if (!capabilities) e.push('capabilities: required array (may be empty)');
  else {
    const bad = capabilities.filter((c) => !isKnownCapability(c));
    if (bad.length) e.push(`capabilities: unknown ${JSON.stringify(bad)}`);
  }

  // dependencies { id: range }
  const dependencies = m.dependencies === undefined ? {} : m.dependencies;
  if (!isPlainObject(dependencies)) e.push('dependencies: must be an object { id: semverRange }');
  else {
    for (const [depId, range] of Object.entries(dependencies)) {
      if (!ID_RE.test(depId)) e.push(`dependencies: invalid dependency id "${depId}"`);
      if (typeof range !== 'string') e.push(`dependencies["${depId}"]: range must be a string`);
    }
  }

  // compatibilityRules { apiVersionRange?, ... }
  const compatibilityRules = m.compatibilityRules === undefined ? {} : m.compatibilityRules;
  if (!isPlainObject(compatibilityRules)) e.push('compatibilityRules: must be an object');

  // lifecycleHooks[] — closed vocabulary
  const lifecycleHooks = m.lifecycleHooks === undefined ? [] : m.lifecycleHooks;
  if (!Array.isArray(lifecycleHooks)) e.push('lifecycleHooks: must be an array');
  else {
    const bad = lifecycleHooks.filter((h) => !isKnownHook(h));
    if (bad.length) e.push(`lifecycleHooks: unknown ${JSON.stringify(bad)}`);
  }

  // configurationSchema — object (a JSON-schema-ish descriptor; shape not enforced here)
  const configurationSchema = m.configurationSchema === undefined ? {} : m.configurationSchema;
  if (!isPlainObject(configurationSchema)) e.push('configurationSchema: must be an object');

  // healthChecks[] — array of { name, intervalMs? }
  const healthChecks = m.healthChecks === undefined ? [] : m.healthChecks;
  if (!Array.isArray(healthChecks)) e.push('healthChecks: must be an array');
  else {
    healthChecks.forEach((h, i) => {
      if (!isPlainObject(h) || typeof h.name !== 'string')
        e.push(`healthChecks[${i}]: must be { name: string, intervalMs?: number }`);
    });
  }

  if (e.length) throw new ManifestError(e);

  return Object.freeze({
    id: m.id,
    name: m.name.trim(),
    version: m.version,
    apiVersion: m.apiVersion,
    author: m.author.trim(),
    description: m.description,
    permissions: Object.freeze([...permissions]),
    capabilities: Object.freeze([...capabilities]),
    dependencies: Object.freeze({ ...dependencies }),
    minimumPlatformVersion: m.minimumPlatformVersion,
    compatibilityRules: Object.freeze({ ...compatibilityRules }),
    lifecycleHooks: Object.freeze([...lifecycleHooks]),
    configurationSchema: Object.freeze({ ...configurationSchema }),
    healthChecks: Object.freeze(healthChecks.map((h) => Object.freeze({ ...h }))),
  });
}

module.exports = { validateManifest, ManifestError, ID_RE };
