'use strict';

/**
 * Co-located gateways — Infrastructure layer.
 * The legacy taxi router also hosts two endpoints that are NOT part of the Trips
 * domain but must keep serving byte-identically after the cutover:
 *  - GET /taxis            → Fleet read (belongs to a future Fleet context)
 *  - GET /places/*         → Maps/Places proxy (belongs to a future Maps context)
 * They are reproduced here as thin reused passthroughs so no SQL/vendor call
 * leaks into Presentation, and are documented for later extraction. No behavior
 * change; no Trips-domain logic.
 *
 * @param {object} deps — the existing DI service container
 */

const { getPlacesAutocomplete, getPlaceDetails } = require('../../services/places');

const sanitizeTaxi = ({ id, name, lat, lng, status }) => ({ id, name, lat, lng, status });

function createFleetReadGateway(deps) {
  const { getCache, setCache, CACHE_TTL, dbAll } = deps;
  return {
    async listTaxis() {
      const cached = getCache('taxis');
      if (cached) return cached;
      const data = await dbAll('SELECT * FROM taxis');
      const safe = data.map(sanitizeTaxi);
      setCache('taxis', safe, CACHE_TTL.taxis);
      return safe;
    },
  };
}

function createPlacesGateway() {
  return {
    autocomplete: (input, lat, lng) => getPlacesAutocomplete(input, lat, lng),
    details: (placeId) => getPlaceDetails(placeId),
  };
}

module.exports = { createFleetReadGateway, createPlacesGateway };
