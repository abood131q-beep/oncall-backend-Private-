'use strict';

/** Location boundary. Existing driver location is a Trip-owned Socket.IO event
 * (trip ownership + route mutation), not a Drivers HTTP capability; it remains
 * untouched under the explicit "do not migrate Trips" constraint. */
function createDriverLocationAdapter() {
  return Object.freeze({});
}
module.exports = { createDriverLocationAdapter };
