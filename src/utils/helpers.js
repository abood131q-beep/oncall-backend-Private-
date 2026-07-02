'use strict';

/**
 * helpers.js — OnCall shared utility functions
 * Pure functions with no side-effects and no external dependencies.
 */

/** Parse JSON safely; return fallback on error */
function safeJSON(str, fallback = []) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/** Strip potentially dangerous characters from user input */
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/[<>"';()&+]/g, '')
    .trim()
    .slice(0, 500);
}

/** Validate that a phone number string is plausible */
function validatePhone(phone) {
  if (!phone) return false;
  const p = String(phone).trim();
  return p.length >= 3 && p.length <= 20 && /^[0-9+\-\s]+$/.test(p);
}

/** Validate geographic coordinates */
function validateCoords(lat, lng) {
  return (
    lat != null &&
    lng != null &&
    !isNaN(lat) &&
    !isNaN(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Haversine distance between two GPS points.
 * @returns {number} Distance in kilometres
 */
function getDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Express middleware: sanitize all string fields in req.body */
function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = sanitize(req.body[key]);
      } else if (Array.isArray(req.body[key])) {
        req.body[key] = req.body[key].map((v) => (typeof v === 'string' ? sanitize(v) : v));
      }
    }
  }
  next();
}

module.exports = { safeJSON, sanitize, validatePhone, validateCoords, getDistanceKm, sanitizeBody };
