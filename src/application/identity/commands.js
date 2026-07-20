'use strict';

/**
 * Identity commands — immutable intent messages (ADR-005 §7) with input
 * validation (§10 kind 1). Validation answers only "is this a coherent
 * request?"; business legality is decided by the Domain, never here.
 */

const { tryCreatePhone } = require('../../domain/shared/Phone');

/** Typed input-rejection codes (presentation maps them to responses). */
const InputRejection = Object.freeze({
  PHONE_REQUIRED: 'PHONE_REQUIRED',
  PHONE_INVALID: 'PHONE_INVALID',
  OTP_REQUIRED: 'OTP_REQUIRED',
  REFRESH_TOKEN_REQUIRED: 'REFRESH_TOKEN_REQUIRED',
});

function invalid(code) {
  return { ok: false, code };
}

function validPhoneOr(raw, onValid) {
  if (!raw) return invalid(InputRejection.PHONE_REQUIRED);
  const phone = tryCreatePhone(raw);
  if (!phone.valid) return invalid(InputRejection.PHONE_INVALID);
  return onValid(phone.value);
}

/** SendOtp { phone } */
function sendOtpCommand({ phone }) {
  return validPhoneOr(phone, (p) => ({ ok: true, command: Object.freeze({ phone: p }) }));
}

/** LoginPassenger { phone, name?, otp?, ip } — registers implicitly if new. */
function loginPassengerCommand({ phone, name, otp, ip }, otpRequired) {
  return validPhoneOr(phone, (p) => {
    if (otpRequired && !otp) return invalid(InputRejection.OTP_REQUIRED);
    return {
      ok: true,
      command: Object.freeze({
        phone: p,
        name: name || undefined,
        otp: otp == null ? undefined : String(otp),
        ip: ip || null,
      }),
    };
  });
}

/** LoginDriver { phone, otp?, ip } — registers implicitly if new. */
function loginDriverCommand({ phone, otp, ip }, otpRequired) {
  return validPhoneOr(phone, (p) => {
    if (otpRequired && !otp) return invalid(InputRejection.OTP_REQUIRED);
    return {
      ok: true,
      command: Object.freeze({
        phone: p,
        otp: otp == null ? undefined : String(otp),
        ip: ip || null,
      }),
    };
  });
}

/** RefreshSession { refreshToken } */
function refreshSessionCommand({ refreshToken }) {
  if (!refreshToken || typeof refreshToken !== 'string') {
    return invalid(InputRejection.REFRESH_TOKEN_REQUIRED);
  }
  return { ok: true, command: Object.freeze({ refreshToken }) };
}

/** Logout { accessToken?, refreshToken? } — never fails from caller's view. */
function logoutCommand({ accessToken, refreshToken }) {
  return {
    ok: true,
    command: Object.freeze({
      accessToken: typeof accessToken === 'string' ? accessToken : undefined,
      refreshToken: typeof refreshToken === 'string' ? refreshToken : undefined,
    }),
  };
}

module.exports = {
  InputRejection,
  sendOtpCommand,
  loginPassengerCommand,
  loginDriverCommand,
  refreshSessionCommand,
  logoutCommand,
};
