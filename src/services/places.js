'use strict';

/**
 * PlacesService — Proxy لـ Google Maps Places API
 *
 * المسؤوليات:
 *  - إرجاع اقتراحات الأماكن (autocomplete) للكويت
 *  - إرجاع تفاصيل مكان محدد (place details)
 *  - التعامل مع غياب GOOGLE_MAPS_API_KEY بهدوء
 *
 * الاستخدام:
 *  const { getPlacesAutocomplete, getPlaceDetails } = require('./src/services/places');
 */

const logger = require('../utils/logger');
// P6-05B / Phase 18.3: read key via the runtime config facade (single approved config-read seam).
const config = require('../config');

const MAPS_BASE = 'https://maps.googleapis.com/maps/api/place';
const DEFAULT_LOCATION = 'location=29.3759,47.9774&radius=50000';

/**
 * يجلب اقتراحات الأماكن من Google Places Autocomplete.
 * @param {string}      input  - نص البحث
 * @param {string|null} lat    - خط عرض الموقع الحالي
 * @param {string|null} lng    - خط طول الموقع الحالي
 * @returns {Promise<object>}  - { predictions: [...] }
 */
async function getPlacesAutocomplete(input, lat, lng) {
  if (!input) return { predictions: [] };

  const apiKey = config.get('GOOGLE_MAPS_API_KEY');
  if (!apiKey) {
    logger.warn('[PlacesService] GOOGLE_MAPS_API_KEY not set — autocomplete disabled');
    return { predictions: [] };
  }

  const location = lat && lng ? `location=${lat},${lng}&radius=50000` : DEFAULT_LOCATION;

  const url =
    `${MAPS_BASE}/autocomplete/json` +
    `?input=${encodeURIComponent(input)}` +
    `&language=ar&components=country:kw` +
    `&${location}` +
    `&key=${apiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500); // 1.5s — يضمن رد سريع حتى لو Google بطيئة
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json();
    clearTimeout(timeoutId);
    // Normalize: always return predictions array (Google may omit it on billing errors)
    return {
      predictions: Array.isArray(data.predictions) ? data.predictions : [],
      status: data.status,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    logger.error('[PlacesService] autocomplete error:', { message: err.message });
    return { predictions: [] };
  }
}

/**
 * يجلب تفاصيل مكان من Google Places Details.
 * @param {string} placeId - معرّف المكان من Google
 * @returns {Promise<object>} - { result: {...} }
 */
async function getPlaceDetails(placeId) {
  if (!placeId) return { result: null };

  const apiKey = config.get('GOOGLE_MAPS_API_KEY');
  if (!apiKey) {
    logger.warn('[PlacesService] GOOGLE_MAPS_API_KEY not set — details disabled');
    return { result: null };
  }

  const url =
    `${MAPS_BASE}/details/json` +
    `?place_id=${encodeURIComponent(placeId)}` +
    `&fields=name,formatted_address,geometry` +
    `&language=ar` +
    `&key=${apiKey}`;

  // إصلاح M5: AbortController timeout — يطابق السلوك مع getPlacesAutocomplete
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s كافٍ لبيانات تفصيلية
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return await response.json();
  } catch (err) {
    clearTimeout(timeoutId);
    logger.error('[PlacesService] details error:', { message: err.message });
    return { result: null };
  }
}

module.exports = { getPlacesAutocomplete, getPlaceDetails };
