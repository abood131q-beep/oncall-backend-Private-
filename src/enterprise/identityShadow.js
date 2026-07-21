'use strict';

/**
 * identityShadow.js — Phase 20.a wiring helpers for the Identity Kernel shadow (ADR-046/047/049).
 *
 * Keeps the flag logic + seed/attach mechanics out of the boot entry. Everything here is gated by
 * two flags (default OFF); with both OFF the boot is byte-identical to before. The kernel is NEVER
 * authoritative — these helpers only enable a read-only parity comparison between the LEGACY
 * identity primitives (middleware/auth.js) and the Consolidated Enterprise Identity Kernel.
 *
 *   PLATFORM_IDENTITY=1 → compose the consolidated kernel sources (legacy + kernel pass-through)
 *   SHADOW_IDENTITY=1   → additionally run parity comparisons (needs PLATFORM_IDENTITY=1)
 */

const {
  createLegacyIdentitySource,
  createKernelIdentitySource,
  createIdentityShadow,
} = require('../platform-adapters/identity');
const { createIdentityTokenAdapter } = require('../infrastructure/identity/tokenAdapter');
const { createIdentityOtpAdapter } = require('../infrastructure/identity/otpAdapter');
const { createIdentityRepository } = require('../infrastructure/identity/identityRepository');

/** Resolve the two Phase-20.a flags from env (or explicit opts overrides). */
function selectIdentityFlags(env = process.env, opts = {}) {
  const platformIdentity =
    opts.platformIdentity != null ? Boolean(opts.platformIdentity) : env.PLATFORM_IDENTITY === '1';
  const shadowIdentity =
    opts.shadowIdentity != null ? Boolean(opts.shadowIdentity) : env.SHADOW_IDENTITY === '1';
  // SHADOW_IDENTITY requires PLATFORM_IDENTITY (can't compare against a kernel that isn't wired).
  return { platformIdentity, shadowIdentity: shadowIdentity && platformIdentity };
}

/**
 * Build the legacy + kernel identity sources from the certified primitives. The kernel token/otp
 * adapters are wired as PASS-THROUGHs to the SAME legacy primitives, so parity measures the kernel
 * seam faithfully (any divergence is a translation/reimplementation defect, never a crypto diff).
 *
 * @param {object} primitives { generateJWT, verifyJWT, adminPhones, requireOtp, ... }
 * @returns {{ legacy, kernel }}
 */
function buildIdentitySources(primitives = {}) {
  const adminPhones = primitives.adminPhones || [];
  const legacy = createLegacyIdentitySource(primitives);
  const tokenPort = createIdentityTokenAdapter(primitives);
  const otpPort = createIdentityOtpAdapter({ requireOtp: primitives.requireOtp });
  // DB-bound ports are wired only when the DB-backed primitives are provided (e.g. the DB parity
  // harness / a running server). Absent ⇒ inert (the pure surface still compares fully).
  const identityRepositoryPort = createIdentityRepository({
    findUserByPhone: primitives.findUserByPhone,
    findDriverByPhone: primitives.findDriverByPhone,
  });
  const kernel = createKernelIdentitySource({
    tokenPort,
    otpPort,
    identityRepositoryPort,
    adminPhones,
  });
  return { legacy, kernel };
}

/**
 * Create the Identity shadow verifier over the composed sources.
 * @returns {object|null} the shadow, or null when PLATFORM_IDENTITY is off.
 */
function attachIdentityShadow({ platformIdentity, shadowIdentity, primitives, logger } = {}) {
  if (!platformIdentity) return null;
  const { legacy, kernel } = buildIdentitySources(primitives || {});
  return createIdentityShadow({
    legacy,
    kernel,
    enabled: () => Boolean(shadowIdentity),
    logger,
  });
}

module.exports = { selectIdentityFlags, buildIdentitySources, attachIdentityShadow };
