'use strict';

const self = (input) => ({ actorPhone: input.actorPhone, ...input });
const admin = (input) => ({ actorPhone: input.actorPhone, actorRole: input.actorRole, ...input });

module.exports = {
  changeAvailabilityCommand: self,
  getProfileCommand: self,
  updateProfileCommand: self,
  getTripsCommand: self,
  getStatsCommand: self,
  getReviewsCommand: self,
  listDriversCommand: admin,
  listPendingCommand: admin,
  getDriverCommand: admin,
  toggleDriverCommand: admin,
  approveDriverCommand: admin,
  rejectDriverCommand: admin,
  suspendDriverCommand: admin,
  reactivateDriverCommand: admin,
  approvalHistoryCommand: admin,
};
