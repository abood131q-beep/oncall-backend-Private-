'use strict';

/**
 * Identity (Phase 14.8 / ADR-027 §2) — PURE domain value object. A unified
 * identity independent of any auth protocol (NOT OAuth/OIDC/Cognito/Auth0).
 *
 * Fields: identityId, principal (login handle), subject (stable subject id),
 * authMethod, credentialHash (never the raw secret), claims, roles, permissions,
 * tenant, metadata, version, state. Credentials are stored ONLY as a salted
 * sha256 hash — the raw secret never lives on the model and never leaves it.
 */

const { IdentityValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');

const STATE = Object.freeze({ ACTIVE: 'active', DISABLED: 'disabled' });

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `idn_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

/** Deterministic salted hash: sha256(identityId::secret). No raw secret retained. */
function hashSecret(identityId, secret) {
  return checksum(`${identityId}::${secret}`);
}

/**
 * @param {object} spec { principal (required), subject?, authMethod?, credentials?:{secret},
 *   claims?, roles?, permissions?, tenant?, metadata?, identityId?, state? }
 * @param {object} [opts] { idFactory }
 */
function createIdentity(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  if (!spec.principal || typeof spec.principal !== 'string') {
    throw new IdentityValidationError('identity: "principal" is required');
  }
  const identityId = spec.identityId || idFactory();
  const secret = spec.credentials && spec.credentials.secret;
  const identity = {
    identityId,
    principal: spec.principal,
    subject: spec.subject || spec.principal,
    authMethod: spec.authMethod || 'password',
    credentialHash: secret ? hashSecret(identityId, secret) : spec.credentialHash || null,
    claims: { ...(spec.claims || {}) },
    roles: Array.isArray(spec.roles) ? [...spec.roles] : [],
    permissions: Array.isArray(spec.permissions) ? [...spec.permissions] : [],
    tenant: spec.tenant || 'default',
    metadata: { ...(spec.metadata || {}) },
    version: spec.version || 1,
    state: spec.state === STATE.DISABLED ? STATE.DISABLED : STATE.ACTIVE,

    isActive() {
      return this.state === STATE.ACTIVE;
    },
    /** Constant-shape secret check; false if no credential is set. */
    verifySecret(candidate) {
      if (!this.credentialHash || candidate == null) return false;
      return this.credentialHash === hashSecret(this.identityId, candidate);
    },
    /** Full model (includes credentialHash) — for the provider store only. */
    toModel() {
      return {
        identityId: this.identityId,
        principal: this.principal,
        subject: this.subject,
        authMethod: this.authMethod,
        credentialHash: this.credentialHash,
        claims: { ...this.claims },
        roles: [...this.roles],
        permissions: [...this.permissions],
        tenant: this.tenant,
        metadata: { ...this.metadata },
        version: this.version,
        state: this.state,
      };
    },
    /** Safe view (NO credentialHash) — for events, SDK, and API responses. */
    toPublic() {
      const m = this.toModel();
      delete m.credentialHash;
      return m;
    },
  };
  return identity;
}

/** Rehydrate an identity entity from a persisted model. */
function fromModel(model, opts = {}) {
  return createIdentity({ ...model, credentials: undefined }, opts);
}

module.exports = { createIdentity, fromModel, hashSecret, STATE };
