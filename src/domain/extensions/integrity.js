'use strict';

/**
 * integrity (Phase 14.2 §10) — checksum + signature + compatibility checks.
 * Uses node:crypto for a real SHA-256 checksum; signature verification is
 * delegated to an injectable verifier port so the trust root (public key / KMS)
 * lives in Infrastructure, not here.
 */

const crypto = require('crypto');
const semver = require('./semver');

/** sha256 hex of a bundle (string or Buffer). */
function checksum(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Verify a bundle matches its declared checksum. */
function verifyChecksum(bytes, expectedHex) {
  if (!expectedHex) return { ok: false, reason: 'no checksum provided' };
  const actual = checksum(bytes);
  return actual === String(expectedHex).toLowerCase()
    ? { ok: true }
    : { ok: false, reason: 'checksum mismatch', actual };
}

/**
 * Verify a signature via an injected verifier: verify(bytes, signature) → bool.
 * With no verifier configured, unsigned extensions are rejected when signing is
 * required (secure default).
 * @param {string|Buffer} bytes
 * @param {string} signature
 * @param {{ verify:(b,sig)=>boolean }|null} verifier
 * @param {{ required?: boolean }} [opts]
 */
function verifySignature(bytes, signature, verifier, opts = {}) {
  if (!verifier || typeof verifier.verify !== 'function') {
    return opts.required
      ? { ok: false, reason: 'signing required but no verifier configured' }
      : { ok: true, skipped: true };
  }
  if (!signature) return { ok: false, reason: 'missing signature' };
  try {
    return verifier.verify(bytes, signature)
      ? { ok: true }
      : { ok: false, reason: 'invalid signature' };
  } catch (err) {
    return { ok: false, reason: `verifier error: ${err.message}` };
  }
}

/**
 * API compatibility: the extension's apiVersion must satisfy the platform's
 * accepted range, and the platform version must be >= minimumPlatformVersion.
 */
function verifyCompatibility(manifest, { platformVersion, platformApiRange }) {
  const problems = [];
  if (!semver.satisfies(manifest.apiVersion, platformApiRange || '*')) {
    problems.push(
      `apiVersion ${manifest.apiVersion} does not satisfy platform API range "${platformApiRange}"`
    );
  }
  if (platformVersion && semver.compare(platformVersion, manifest.minimumPlatformVersion) < 0) {
    problems.push(
      `platform ${platformVersion} < required minimumPlatformVersion ${manifest.minimumPlatformVersion}`
    );
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

module.exports = { checksum, verifyChecksum, verifySignature, verifyCompatibility };
