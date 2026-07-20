'use strict';

/**
 * Identity use cases — Application layer (ADR-005 §5/§6).
 *
 * Each use case executes the canonical lifecycle for its command: gates →
 * domain decision → side effects via ports → typed result. Behavior is a 1:1
 * migration of src/routes/auth.js (strangler Phase 1): identical outcomes,
 * identical ordering of security-relevant steps.
 *
 * Results: { ok: true, value } | { ok: false, code, ...details }.
 * No transport, storage, or vendor knowledge exists here (ADR-005 §4).
 */

const { maskPhone } = require('../../domain/shared/Phone');
const {
  IdentityRejection,
  passengerLoginGate,
  driverLoginGate,
  driverRefreshGate,
  isAdminPhone,
  passengerSessionPayload,
  driverSessionPayload,
} = require('../../domain/identity/loginPolicy');

const AuthRejection = Object.freeze({
  ...IdentityRejection,
  OTP_INVALID: 'OTP_INVALID',
  REFRESH_INVALID: 'REFRESH_INVALID',
  DRIVER_REFRESH_BLOCKED: 'DRIVER_REFRESH_BLOCKED',
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
});

function createIdentityUseCases(ports) {
  const { identityRepository, tokenGateway, otpGateway, auditLog, adminPhones } = ports;

  /** Shared OTP gate — order preserved: OTP verified before any account work. */
  async function otpGate(command, requestId) {
    if (!otpGateway.isRequired()) return { ok: true };
    const valid = await otpGateway.verify(command.phone, command.otp, { requestId });
    return valid ? { ok: true } : { ok: false, code: AuthRejection.OTP_INVALID };
  }

  /** SendOtp — generates, stores, and dispatches a verification code. */
  async function sendOtp(command, ctx = {}) {
    await otpGateway.send(command.phone, { requestId: ctx.requestId });
    return { ok: true, value: {} };
  }

  /** LoginPassenger — implicit registration, account gate, session issue. */
  async function loginPassenger(command, ctx = {}) {
    const otp = await otpGate(command, ctx.requestId);
    if (!otp.ok) return otp;

    let user = await identityRepository.findUserByPhone(command.phone);
    if (!user) user = await identityRepository.createUser(command.phone, command.name);

    const gate = passengerLoginGate(user);
    if (!gate.allowed) return { ok: false, code: gate.code };

    const admin = isAdminPhone(command.phone, adminPhones);
    const payload = passengerSessionPayload(user, command.phone, admin);
    const token = tokenGateway.issueAccessToken(payload);
    // Contract: admins receive a long-lived access token and no refresh token.
    const refreshToken = admin ? null : await tokenGateway.issueRefreshToken(payload);

    identityRepository.recordLoginLog(command.phone, 'passenger', command.ip);
    auditLog.info(`Passenger login: ${maskPhone(command.phone)}`);
    return { ok: true, value: { user, token, refreshToken } };
  }

  /** LoginDriver — implicit registration, approval gate (single source of truth). */
  async function loginDriver(command, ctx = {}) {
    const otp = await otpGate(command, ctx.requestId);
    if (!otp.ok) return otp;

    let driver = await identityRepository.findDriverByPhone(command.phone);
    if (!driver) driver = await identityRepository.createDriver(command.phone);

    const gate = driverLoginGate(driver);
    if (!gate.allowed) {
      auditLog.info(`Driver login blocked (${gate.status}): ${maskPhone(command.phone)}`);
      return { ok: false, code: gate.code, status: gate.status, reason: gate.reason };
    }

    await identityRepository.setDriverPresence(command.phone, driver.id, 'offline');

    const payload = driverSessionPayload(driver, command.phone);
    const token = tokenGateway.issueAccessToken(payload);
    const refreshToken = await tokenGateway.issueRefreshToken(payload);

    identityRepository.recordLoginLog(command.phone, 'driver', command.ip);
    auditLog.info(`Driver login: ${maskPhone(command.phone)}`);
    return { ok: true, value: { driver, token, refreshToken } };
  }

  /** RefreshSession — rotation; non-approved drivers are blocked AND revoked. */
  async function refreshSession(command) {
    const payload = await tokenGateway.verifyRefreshToken(command.refreshToken);
    if (!payload) return { ok: false, code: AuthRejection.REFRESH_INVALID };

    if (payload.type === 'driver') {
      const driver = await identityRepository.findDriverByPhone(payload.phone);
      const gate = driverRefreshGate(driver);
      if (!gate.allowed) {
        // Security order preserved: revoke immediately, then reject.
        await tokenGateway.revokeRefreshToken(command.refreshToken);
        auditLog.security('DRIVER_REFRESH_BLOCKED', {
          phone: maskPhone(payload.phone),
          status: gate.status,
        });
        return { ok: false, code: AuthRejection.DRIVER_REFRESH_BLOCKED, status: gate.status };
      }
    }

    const token = tokenGateway.issueAccessToken(payload);
    await tokenGateway.revokeRefreshToken(command.refreshToken);
    const refreshToken = await tokenGateway.issueRefreshToken(payload);

    auditLog.info(`Token refreshed: ${maskPhone(payload.phone)}`);
    return { ok: true, value: { token, refreshToken } };
  }

  /** Logout — best-effort revocation; never fails from the caller's view. */
  async function logout(command) {
    try {
      const payload = command.accessToken
        ? tokenGateway.verifyAccessToken(command.accessToken)
        : null;
      if (payload) {
        tokenGateway.revokeAccessTokens(payload.phone);
        auditLog.info(`Logout + access token revoked: ${maskPhone(payload.phone)}`);
      }
      if (command.refreshToken) await tokenGateway.revokeRefreshToken(command.refreshToken);
    } catch {
      /* logout never fails from the user's perspective (legacy contract) */
    }
    return { ok: true, value: {} };
  }

  /** LogoutAll — requires an authenticated actor (authorization policy). */
  async function logoutAll(actor) {
    if (!actor || !actor.phone) return { ok: false, code: AuthRejection.NOT_AUTHENTICATED };
    tokenGateway.revokeAccessTokens(actor.phone);
    await tokenGateway.revokeAllRefreshTokens(actor.phone);
    auditLog.info(`Logout all devices: ${maskPhone(actor.phone)}`);
    return { ok: true, value: {} };
  }

  /** VerifySession — query (never mutates): full session payload or null. */
  function verifySession(accessToken) {
    const session = accessToken ? tokenGateway.verifyAccessToken(accessToken) : null;
    if (!session) return { ok: false, code: AuthRejection.NOT_AUTHENTICATED };
    return { ok: true, value: { session } };
  }

  /** IsAdmin — query, data-minimized: boolean only (P6-05D contract). */
  function checkAdmin(accessToken) {
    const payload = accessToken ? tokenGateway.verifyAccessToken(accessToken) : null;
    if (!payload) return { ok: false, code: AuthRejection.NOT_AUTHENTICATED };
    const admin = payload.role === 'admin' || isAdminPhone(payload.phone, adminPhones);
    return { ok: true, value: { isAdmin: admin } };
  }

  return {
    sendOtp,
    loginPassenger,
    loginDriver,
    refreshSession,
    logout,
    logoutAll,
    verifySession,
    checkAdmin,
  };
}

module.exports = { createIdentityUseCases, AuthRejection };
