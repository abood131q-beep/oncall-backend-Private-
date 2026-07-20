'use strict';

/**
 * Users domain — Status Policy + Preferences Policy (ADR-002 §5, ADR-005 §1).
 *
 * These are the invariants; the Application layer asks, this module decides.
 * Pure: no I/O, no framework, no persistence (ADR-005 §18).
 *
 * Behavior is a 1:1 extraction of the decisions embedded in the legacy
 * src/routes/users.js. Any intentional change requires an ADR amendment.
 */

/** Outcome codes shared with the Application layer. */
const UsersRejection = Object.freeze({
  FORBIDDEN_OTHER_USER: 'FORBIDDEN_OTHER_USER',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
});

/**
 * UserStatusPolicy — read-authorization for balance.
 *
 * Mirrors the legacy `/balance/:phone` guard exactly:
 *   `if (req.params.phone !== req.user.phone) → 403 'غير مصرح'`.
 * A subject may read ONLY their own balance. The path phone is the claimed
 * target; the authenticated phone is the actor.
 *
 * NOTE (preserved asymmetry): the legacy `/transactions/:phone` and
 * `/notifications/:phone` do NOT perform this check — they ignore the path
 * phone and always act on the authenticated phone. That asymmetry is
 * deliberate and reproduced by the use cases (no policy call there).
 *
 * @returns {{ allowed: true } | { allowed: false, code: string }}
 */
function balanceReadAuthorization(actorPhone, targetPhone) {
  if (targetPhone !== actorPhone) {
    return { allowed: false, code: UsersRejection.FORBIDDEN_OTHER_USER };
  }
  return { allowed: true };
}

/**
 * UserPreferencesPolicy — normalization rules for user-authored content.
 *
 * WIRED: `reportType` mirrors the legacy default `type || 'general'`.
 * DOMAIN-MODELED (not yet wired): notification/locale preference defaults are
 * modeled here for Phase 4; no legacy endpoint mutates them today.
 */
function normalizeReportType(rawType) {
  return rawType || 'general';
}

module.exports = {
  UsersRejection,
  balanceReadAuthorization,
  normalizeReportType,
};
