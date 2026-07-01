'use strict';

/**
 * AnalyticsService — تقارير وتحليلات متقدمة للمشروع
 *
 * إصلاح M3: استبدال string interpolation في SQL بـ parameterized queries.
 * السبب: SQLite لا يقبل bind parameters في ثاني argument لـ datetime()،
 * لذا نحسب التاريخ في JavaScript ونمرره كـ ISO string مرتبط.
 */

/**
 * يجمع جميع بيانات التحليلات لفترة زمنية محددة.
 * @param {Function} dbGet  - Promise wrapper لـ db.get
 * @param {Function} dbAll  - Promise wrapper لـ db.all
 * @param {number}   period - عدد الأيام (1-365)، افتراضي 30
 * @returns {Promise<object>} كائن التحليلات الكامل
 */
async function getAnalytics(dbGet, dbAll, period = 30) {
  const p = Math.max(1, Math.min(365, Number(period) || 30));

  // حساب تاريخ البداية في JavaScript — يُمرَّر كـ param آمن بدلاً من string interpolation
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - p);
  const cutoffStr = cutoff.toISOString().replace('T', ' ').slice(0, 19);

  const cutoff365 = new Date();
  cutoff365.setDate(cutoff365.getDate() - 365);
  const cutoff365Str = cutoff365.toISOString().replace('T', ' ').slice(0, 19);

  const [
    overview,
    dailyRevenue,
    monthlyRevenue,
    topDrivers,
    topPickups,
    topDestinations,
    avgArrivalTime,
    hourlyDistribution,
    userGrowth,
  ] = await Promise.all([
    // نظرة عامة
    dbGet(
      `SELECT COUNT(*) as total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN status='completed' THEN final_fare ELSE 0 END) as revenue,
        AVG(CASE WHEN status='completed' THEN final_fare     END) as avg_fare,
        AVG(CASE WHEN status='completed' THEN duration_minutes END) as avg_duration,
        AVG(CASE WHEN status='completed' THEN total_distance    END) as avg_distance
       FROM trips WHERE created_at >= ?`,
      [cutoffStr]
    ),

    // إيرادات يومية
    dbAll(
      `SELECT date(created_at) as day, COUNT(*) as total_trips,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN status='completed' THEN final_fare ELSE 0 END) as revenue,
        AVG(CASE WHEN status='completed' THEN duration_minutes END) as avg_duration
       FROM trips WHERE created_at >= ?
       GROUP BY date(created_at) ORDER BY day ASC`,
      [cutoffStr]
    ),

    // إيرادات شهرية (آخر 365 يوم دائماً)
    dbAll(
      `SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as total_trips,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status='completed' THEN final_fare ELSE 0 END) as revenue
       FROM trips WHERE created_at >= ?
       GROUP BY strftime('%Y-%m', created_at) ORDER BY month ASC`,
      [cutoff365Str]
    ),

    // أفضل السائقين
    dbAll(
      `SELECT driver_name, COUNT(*) as total_trips,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status='completed' THEN final_fare ELSE 0 END) as earnings,
        AVG(CASE WHEN rating IS NOT NULL THEN rating END) as avg_rating,
        AVG(CASE WHEN status='completed' THEN duration_minutes END) as avg_trip_time,
        ROUND(100.0 * SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) / COUNT(*), 1) as completion_rate
       FROM trips WHERE driver_name IS NOT NULL AND driver_name != ''
         AND created_at >= ?
       GROUP BY driver_name ORDER BY completed DESC LIMIT 10`,
      [cutoffStr]
    ),

    // أكثر نقاط الانطلاق طلباً
    dbAll(
      `SELECT pickup, COUNT(*) as requests,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed
       FROM trips WHERE pickup IS NOT NULL AND pickup != ''
         AND created_at >= ?
       GROUP BY pickup ORDER BY requests DESC LIMIT 10`,
      [cutoffStr]
    ),

    // أكثر الوجهات طلباً
    dbAll(
      `SELECT destination, COUNT(*) as requests FROM trips
       WHERE destination IS NOT NULL AND destination != ''
         AND created_at >= ?
       GROUP BY destination ORDER BY requests DESC LIMIT 10`,
      [cutoffStr]
    ),

    // متوسط وقت الوصول
    dbGet(
      `SELECT AVG(duration_minutes) as avg_arrival FROM trips
       WHERE status = 'completed' AND duration_minutes > 0
         AND created_at >= ?`,
      [cutoffStr]
    ),

    // توزيع الرحلات حسب الساعة
    dbAll(
      `SELECT strftime('%H', created_at) as hour, COUNT(*) as trips FROM trips
       WHERE created_at >= ?
       GROUP BY strftime('%H', created_at) ORDER BY hour ASC`,
      [cutoffStr]
    ),

    // نمو المستخدمين
    dbAll(
      `SELECT date(created_at) as day, COUNT(*) as new_users FROM users
       WHERE created_at >= ?
       GROUP BY date(created_at) ORDER BY day ASC`,
      [cutoffStr]
    ),
  ]);

  return {
    success: true,
    period: p,
    overview,
    dailyRevenue,
    monthlyRevenue,
    topDrivers,
    topPickups,
    topDestinations,
    avgArrivalTime: avgArrivalTime?.avg_arrival || 0,
    hourlyDistribution,
    userGrowth,
  };
}

module.exports = { getAnalytics };
