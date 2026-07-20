'use strict';

/**
 * Fleet controller — Presentation layer.
 * HTTP translation only; ZERO business logic (ADR-005 §4). Every outcome is a
 * typed result from the application; this file maps it to the frozen response
 * contract (status, JSON shape, key order, Arabic messages must remain
 * byte-identical to the legacy co-located handlers in Trips/Admin). Proven by
 * the live A/B harness.
 *
 * GLOBALIZATION (ADR-003, non-breaking): Arabic is the frozen default; English
 * is additive via `Accept-Language: en` and never alters Arabic output.
 */

const { FleetError } = require('../../application/fleet/useCases');

const ar = Object.freeze({
  [FleetError.VEHICLE_NAME_REQUIRED]: 'اسم التاكسي مطلوب',
  [FleetError.BAD_COORDS]: 'إحداثيات غير صحيحة',
});
const en = Object.freeze({
  [FleetError.VEHICLE_NAME_REQUIRED]: 'Taxi name is required',
  [FleetError.BAD_COORDS]: 'Invalid coordinates',
});
function msg(req, code) {
  return String(req.headers['accept-language'] || '')
    .toLowerCase()
    .startsWith('en')
    ? en[code] || code
    : ar[code] || code;
}
const BARE = { success: false };

function createFleetController(fleetApp) {
  const { useCases, commands } = fleetApp;

  return {
    // GET /taxis — public sanitized list; 500 → { success:false }
    async listVehicles(req, res) {
      try {
        const r = await useCases.listVehicles();
        res.json(r.value);
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    // POST /admin/taxis — validation 400 (localized), success { success:true, id }
    async registerVehicle(req, res) {
      try {
        const b = req.body || {};
        const r = await useCases.registerVehicle(
          commands.registerCommand({ name: b.name, lat: b.lat, lng: b.lng }).command
        );
        if (!r.ok) return res.status(400).json({ success: false, message: msg(req, r.code) });
        res.json({ success: true, id: r.value.id });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    // DELETE /admin/taxis/:id — success { success:true }; 500 → { success:false }
    async removeVehicle(req, res) {
      try {
        await useCases.removeVehicle(commands.idCommand({ id: req.params.id }).command);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },
  };
}

module.exports = { createFleetController };
