'use strict';

/**
 * CacheService — ذاكرة تخزين مؤقت في الذاكرة (In-Memory Cache)
 *
 * المسؤوليات:
 *  - تخزين البيانات مع TTL (مدة صلاحية)
 *  - استرجاع البيانات أو null إذا انتهت صلاحيتها
 *  - حذف البيانات بناءً على نمط (pattern) في الـ key
 *  - تنظيف تلقائي للمفاتيح المنتهية كل 30 ثانية
 *
 * الاستخدام:
 *  const { cache, CACHE_TTL, getCache, setCache, clearCache } = require('./src/services/cache');
 */

/** Map الرئيسية — تُمرَّر للـ health route لقراءة .size */
const cache = new Map();

/** TTL الافتراضية بالميلي ثانية لكل نوع بيانات */
const CACHE_TTL = {
  scooters: 10000, // 10 ثوانٍ
  taxis: 10000, // 10 ثوانٍ
  stats: 30000, // 30 ثانية
  trips: 5000, // 5 ثوانٍ
};

/**
 * يسترجع بيانات من الـ cache.
 * يعيد null إذا لم يجد المفتاح أو انتهت صلاحيته.
 * @param {string} key
 * @returns {*|null}
 */
function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

/**
 * يخزّن بيانات في الـ cache مع TTL.
 * @param {string} key
 * @param {*} data
 * @param {number} [ttl=10000] - مدة الصلاحية بالميلي ثانية
 */
function setCache(key, data, ttl = 10000) {
  cache.set(key, { data, expiry: Date.now() + ttl });
}

/**
 * يحذف جميع المفاتيح التي تحتوي على النمط المعطى.
 * @param {string} pattern
 */
function clearCache(pattern) {
  for (const key of cache.keys()) {
    if (key.includes(pattern)) cache.delete(key);
  }
}

// تنظيف تلقائي للمفاتيح المنتهية كل 30 ثانية
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of cache.entries()) {
    if (now > item.expiry) cache.delete(key);
  }
}, 30000);

module.exports = { cache, CACHE_TTL, getCache, setCache, clearCache };
