'use strict';

/**
 * User repository adapter — Infrastructure layer.
 * Implements the userRepository port (application/users/ports.js) by
 * delegating to the existing, tested repository factories received through
 * the DI container. No new persistence logic is introduced (strangler rule:
 * wrap first, extract later). All SQL stays inside these repositories.
 *
 * @param {object} deps — the existing DI service container (server.js `services`)
 */
function createUserRepositoryAdapter(deps) {
  const { userRepo, reportRepo } = deps;

  return {
    // Update Profile — returns the updated `users` row (legacy contract).
    updateName: (phone, name) => userRepo.updateName(phone, name),

    // User Reports — INSERT into reports (fire-and-return like legacy).
    submitReport: (phone, type, description, tripId) =>
      reportRepo.create(phone, type, description, tripId),
  };
}

module.exports = { createUserRepositoryAdapter };
