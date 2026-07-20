'use strict';

/** Session/socket side effects invoked only after the approval transaction commits. */
function createDriverSessionControlAdapter(deps) {
  const { revokeTokens, revokeAllRefreshTokens, dbRun, io } = deps;
  return {
    revokeAccess: (phone) => revokeTokens(phone),
    revokeRefresh: (phone) => revokeAllRefreshTokens(phone, dbRun),
    forceDisconnect: (phone) => {
      io.to(`driver:${phone}`).emit('force_disconnect', {
        reason: 'account_suspended',
        message: 'تم إيقاف حسابك من قبل المشرف.',
      });
      io.in(`driver:${phone}`).socketsLeave('drivers:online');
      io.in(`driver:${phone}`).disconnectSockets(true);
    },
  };
}
module.exports = { createDriverSessionControlAdapter };
