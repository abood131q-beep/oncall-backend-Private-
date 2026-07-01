'use strict';

/**
 * FareCalculatorService — حساب أجرة الرحلات
 *
 * المسؤوليات:
 *  - تحديد سعر الكيلومتر والدقيقة والرسوم الثابتة
 *  - تطبيق مضاعفات الذروة (×1.5) والليل (×1.25)
 *  - حساب الأجرة النهائية مع تفصيل كامل
 *  - تنسيق بيانات الرحلة (formatTrip)
 *
 * الاستخدام:
 *  const { FARE_CONFIG, getPriceMultiplier, calculateFare, getFareBreakdown, formatTrip }
 *    = require('./src/services/fareCalculator');
 */

/** إعدادات الأجرة الرئيسية — مجمّدة لمنع التعديل العرضي */
const FARE_CONFIG = Object.freeze({
  baseFare: 0.5, // رسوم البداية (د.ك)
  perKm: 0.2, // سعر الكيلومتر
  perMinute: 0.015, // سعر الدقيقة
  minimumFare: 0.75, // الحد الأدنى للأجرة
  peakMultiplier: 1.5, // مضاعف ساعات الذروة
  nightMultiplier: 1.25, // مضاعف الليل
  peakHours: Object.freeze([
    Object.freeze({ start: 7, end: 9 }), // ذروة الصباح
    Object.freeze({ start: 16, end: 19 }), // ذروة المساء
  ]),
  nightHours: Object.freeze({ start: 23, end: 5 }), // ساعات الليل
});

/**
 * يحدد المضاعف الحالي بناءً على وقت اليوم.
 * @returns {{ multiplier: number, label: string }}
 */
function getPriceMultiplier() {
  const hour = new Date().getHours();

  for (const peak of FARE_CONFIG.peakHours) {
    if (hour >= peak.start && hour < peak.end) {
      return { multiplier: FARE_CONFIG.peakMultiplier, label: '🔥 ذروة' };
    }
  }

  const { start, end } = FARE_CONFIG.nightHours;
  if (hour >= start || hour < end) {
    return { multiplier: FARE_CONFIG.nightMultiplier, label: '🌙 ليلي' };
  }

  return { multiplier: 1.0, label: 'عادي' };
}

/**
 * يحسب الأجرة النهائية كرقم واحد.
 * @param {number} distanceKm
 * @param {number} [durationMinutes=0]
 * @param {boolean} [applyMultiplier=false]
 * @returns {number} الأجرة بـ 3 خانات عشرية
 */
function calculateFare(distanceKm, durationMinutes = 0, applyMultiplier = false) {
  const { multiplier } = getPriceMultiplier();
  const distanceFare = distanceKm * FARE_CONFIG.perKm;
  const timeFare = durationMinutes * FARE_CONFIG.perMinute;
  const subtotal = FARE_CONFIG.baseFare + distanceFare + timeFare;
  const total = applyMultiplier ? subtotal * multiplier : subtotal;
  return Math.round(Math.max(total, FARE_CONFIG.minimumFare) * 1000) / 1000;
}

/**
 * يحسب الأجرة مع تفصيل كامل لعرضه في الـ API.
 * @param {number} distanceKm
 * @param {number} [durationMinutes=0]
 * @returns {object} تفصيل الأجرة
 */
function getFareBreakdown(distanceKm, durationMinutes = 0) {
  const { multiplier, label } = getPriceMultiplier();
  const distanceFare = distanceKm * FARE_CONFIG.perKm;
  const timeFare = durationMinutes * FARE_CONFIG.perMinute;
  const subtotal = FARE_CONFIG.baseFare + distanceFare + timeFare;
  const withMultiplier = subtotal * multiplier;
  const total = Math.max(withMultiplier, FARE_CONFIG.minimumFare);

  return {
    baseFare: FARE_CONFIG.baseFare,
    distanceFare: Math.round(distanceFare * 1000) / 1000,
    timeFare: Math.round(timeFare * 1000) / 1000,
    subtotal: Math.round(subtotal * 1000) / 1000,
    multiplier,
    priceType: label,
    total: Math.round(total * 1000) / 1000,
    breakdown: `${FARE_CONFIG.baseFare} + ${distanceKm.toFixed(2)}km × ${FARE_CONFIG.perKm} + ${durationMinutes}min × ${FARE_CONFIG.perMinute}`,
  };
}

/**
 * يحوّل سجل رحلة من DB إلى شكل API-friendly.
 * إصلاح M10: حذف الحقول الداخلية التي لا يحتاجها Flutter.
 * يُعيد null إذا كان الإدخال null/undefined.
 * @param {object|null} t - صف من جدول trips
 * @returns {object|null}
 */
function formatTrip(t) {
  if (!t) return null;
  // eslint-disable-next-line no-unused-vars
  const {
    rejected_drivers: _rd,
    assigned_driver_id: _adi,
    assigned_driver_name: _adn,
    request_sent_at: _rsa,
    estimated_fare: _ef,
    final_fare: _ff,
    pickup_lat: _plat,
    pickup_lng: _plng,
    driver_lat: _dlat,
    driver_lng: _dlng,
    dest_lat: _delat,
    dest_lng: _delng,
    ...rest
  } = t;

  return {
    ...rest,
    route: (() => {
      try {
        return JSON.parse(t.route || '[]');
      } catch {
        return [];
      }
    })(),
    estimatedFare: t.estimated_fare,
    finalFare: t.final_fare,
    pickupLat: t.pickup_lat,
    pickupLng: t.pickup_lng,
    driverLat: t.driver_lat,
    driverLng: t.driver_lng,
    destLat: t.dest_lat,
    destLng: t.dest_lng,
  };
}

module.exports = { FARE_CONFIG, getPriceMultiplier, calculateFare, getFareBreakdown, formatTrip };
