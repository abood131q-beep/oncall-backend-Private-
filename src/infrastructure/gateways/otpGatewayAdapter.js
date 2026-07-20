'use strict';

/**
 * OTP gateway adapter — Infrastructure layer.
 * Implements the otpGateway port by delegating to the existing OTP service
 * (src/services/otpService.js). Provider mechanics stay behind this boundary.
 */

const { sendOTP, verifyOTP } = require('../../services/otpService');

function createOtpGatewayAdapter(deps) {
  const { dbGet, dbRun, logger, requireOtp, smsProvider } = deps;

  return {
    isRequired: () => Boolean(requireOtp),

    send: (phone, ctx = {}) =>
      sendOTP(phone, dbRun, logger, { requestId: ctx.requestId, provider: smsProvider }),

    verify: (phone, code, ctx = {}) =>
      verifyOTP(phone, String(code), dbGet, dbRun, {
        logger,
        requestId: ctx.requestId,
        provider: smsProvider,
      }),
  };
}

module.exports = { createOtpGatewayAdapter };
