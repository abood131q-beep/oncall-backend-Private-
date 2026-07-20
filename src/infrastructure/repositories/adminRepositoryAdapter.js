'use strict';

/**
 * Admin repository adapter — Infrastructure layer.
 * Implements the adminRepository port. The heavy dashboard/stats/revenue SQL
 * that lived inside the legacy route now lives here, behind the port — the
 * statements are byte-for-byte the legacy ones, so behavior is preserved while
 * the layering is corrected (ADR-005/ADR-004). Reuses existing repositories for
 * user/report/trip operations; taxi writes stay raw (Fleet not yet migrated).
 *
 * @param {object} deps — the existing DI service container
 */
const fs = require('fs');
const path = require('path');

function createAdminRepositoryAdapter(deps) {
  const {
    dbGet,
    dbAll,
    dbRun,
    userRepo,
    driverRepo,
    tripRepo,
    reportRepo,
    formatTrip,
    io,
    getMetrics,
    notifService,
    logger,
    PORT,
  } = deps;

  async function getStats() {
    const totalTrips = await dbGet('SELECT COUNT(*) as c FROM trips');
    const totalDrivers = await dbGet('SELECT COUNT(*) as c FROM drivers');
    const totalUsers = await dbGet('SELECT COUNT(*) as c FROM users');
    const revenue = await dbGet(
      "SELECT SUM(final_fare) as total FROM trips WHERE status='completed'"
    );
    const activeTrips = await dbGet(
      "SELECT COUNT(*) as c FROM trips WHERE status IN ('accepted','arrived','in_progress')"
    );
    const onlineDrivers = await dbGet("SELECT COUNT(*) as c FROM drivers WHERE status='online'");
    const todayTrips = await dbGet(
      `SELECT COUNT(*) as c FROM trips WHERE created_at >= datetime('now','start of day')`
    );
    const todayRevenue = await dbGet(
      `SELECT SUM(final_fare) as total FROM trips WHERE status='completed' AND created_at >= datetime('now','start of day')`
    );
    const weekTrips = await dbGet(
      `SELECT COUNT(*) as c FROM trips WHERE created_at >= datetime('now','-7 days')`
    );
    const weekRevenue = await dbGet(
      `SELECT SUM(final_fare) as total FROM trips WHERE status='completed' AND created_at >= datetime('now','-7 days')`
    );
    const dailyStats = await dbAll(`
        SELECT date(created_at) as day, COUNT(*) as trips,
          SUM(CASE WHEN status='completed' THEN final_fare ELSE 0 END) as revenue
        FROM trips WHERE created_at >= datetime('now','-7 days')
        GROUP BY date(created_at) ORDER BY day ASC
      `);
    const topDrivers = await dbAll(`
        SELECT driver_id, driver_name, COUNT(*) as total_trips,
          SUM(CASE WHEN status='completed' THEN final_fare ELSE 0 END) as earnings,
          AVG(CASE WHEN rating IS NOT NULL THEN rating END) as avg_rating
        FROM trips WHERE driver_id IS NOT NULL
        GROUP BY driver_id ORDER BY total_trips DESC LIMIT 5
      `);
    return {
      totalTrips: totalTrips.c,
      totalDrivers: totalDrivers.c,
      totalUsers: totalUsers.c,
      totalRevenue: revenue.total || 0,
      activeTrips: activeTrips.c,
      onlineDrivers: onlineDrivers.c,
      todayTrips: todayTrips.c,
      todayRevenue: todayRevenue.total || 0,
      weekTrips: weekTrips.c,
      weekRevenue: weekRevenue.total || 0,
      dailyStats,
      topDrivers,
    };
  }

  async function getRevenue() {
    const daily = await dbAll(`
        SELECT date(created_at) as day, COUNT(*) as trips,
          SUM(CASE WHEN status='completed' THEN final_fare ELSE 0 END) as revenue
        FROM trips WHERE created_at >= datetime('now','-30 days')
        GROUP BY date(created_at) ORDER BY day DESC
      `);
    const total = await dbGet("SELECT SUM(final_fare) as t FROM trips WHERE status='completed'");
    const month = await dbGet(
      "SELECT SUM(final_fare) as t FROM trips WHERE status='completed' AND created_at >= datetime('now','-30 days')"
    );
    return { success: true, daily, total: total.t || 0, month: month.t || 0 };
  }

  async function getDashboard() {
    const [
      drvOnline,
      drvBusy,
      drvOffline,
      drvTotal,
      tripsActive,
      tripsWaiting,
      tripsCompleted,
      tripsTodayCompleted,
      tripsTotal,
      scAvail,
      scInUse,
      scMaint,
      scTotal,
      scooterTripsActive,
      totalUsers,
      activeUsersToday,
    ] = await Promise.all([
      dbGet("SELECT COUNT(*) as c FROM drivers WHERE status='online'"),
      dbGet("SELECT COUNT(*) as c FROM drivers WHERE status='busy'"),
      dbGet("SELECT COUNT(*) as c FROM drivers WHERE status='offline'"),
      dbGet('SELECT COUNT(*) as c FROM drivers'),
      dbGet("SELECT COUNT(*) as c FROM trips WHERE status IN ('accepted','arrived','in_progress')"),
      dbGet("SELECT COUNT(*) as c FROM trips WHERE status='waiting_driver'"),
      dbGet("SELECT COUNT(*) as c FROM trips WHERE status='completed'"),
      dbGet(
        "SELECT COUNT(*) as c FROM trips WHERE status='completed' AND created_at >= datetime('now','-1 day')"
      ),
      dbGet('SELECT COUNT(*) as c FROM trips'),
      dbGet("SELECT COUNT(*) as c FROM scooters WHERE status='available'"),
      dbGet("SELECT COUNT(*) as c FROM scooters WHERE status NOT IN ('available','maintenance')"),
      dbGet("SELECT COUNT(*) as c FROM scooters WHERE status='maintenance'"),
      dbGet('SELECT COUNT(*) as c FROM scooters'),
      dbGet("SELECT COUNT(*) as c FROM scooter_rides WHERE status='active'"),
      dbGet('SELECT COUNT(*) as c FROM users'),
      dbGet(
        "SELECT COUNT(DISTINCT user_phone) as c FROM trips WHERE created_at >= datetime('now','-1 day')"
      ),
    ]);

    const socketClients = io.engine ? io.engine.clientsCount : 0;
    let passengersOnline = 0;
    let driversOnlineSocket = 0;
    try {
      for (const [roomName] of io.sockets.adapter.rooms) {
        if (roomName.startsWith('passenger:')) passengersOnline++;
      }
      const driversRoom = io.sockets.adapter.rooms.get('drivers:online');
      driversOnlineSocket = driversRoom ? driversRoom.size : 0;
    } catch {
      /* ignore */
    }

    const mem = process.memoryUsage();
    const memUsedMB = Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10;
    const memTotalMB = Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10;
    const rssMB = Math.round((mem.rss / 1024 / 1024) * 10) / 10;
    const externalMB = Math.round((mem.external / 1024 / 1024) * 10) / 10;

    let dbSizeKB = 0;
    try {
      dbSizeKB = Math.round(fs.statSync(path.join(process.cwd(), 'oncall.db')).size / 1024);
    } catch {
      /* ignore */
    }

    let lastBackup = null;
    let backupCount = 0;
    try {
      const backupDir = path.join(process.cwd(), 'backups');
      if (fs.existsSync(backupDir)) {
        const files = fs
          .readdirSync(backupDir)
          .filter((f) => f.endsWith('.db'))
          .sort();
        backupCount = files.length;
        if (files.length) {
          const last = files[files.length - 1];
          const stat = fs.statSync(path.join(backupDir, last));
          lastBackup = { name: last, date: stat.mtime, sizeKB: Math.round(stat.size / 1024) };
        }
      }
    } catch {
      /* ignore */
    }

    const { responseTimes, cpuPercent } = getMetrics();
    let avgResponseMs = 0;
    let p95ResponseMs = 0;
    let minResponseMs = 0;
    let maxResponseMs = 0;
    if (responseTimes.length) {
      const sorted = [...responseTimes].sort((a, b) => a - b);
      avgResponseMs = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
      p95ResponseMs = sorted[Math.floor(sorted.length * 0.95)] || 0;
      minResponseMs = sorted[0];
      maxResponseMs = sorted[sorted.length - 1];
    }

    const recentLogs = logger.getLogs(20);
    const metrics = getMetrics();
    const notifStats = notifService?.getStats ? notifService.getStats() : { isConfigured: false };
    const recentErrors = logger.getErrors(5);
    const recentCrashes = logger.getCrashes(5);
    const uptimeSec = Math.round(process.uptime());
    const uptimeHuman = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;

    return {
      success: true,
      timestamp: new Date().toISOString(),
      server: {
        status: 'online',
        pid: process.pid,
        platform: process.platform,
        nodeVersion: process.version,
        port: PORT,
        uptime: uptimeSec,
        uptimeHuman,
      },
      users: { total: totalUsers.c, activeToday: activeUsersToday.c },
      passengers: { online: passengersOnline },
      drivers: {
        online: drvOnline.c,
        busy: drvBusy.c,
        offline: drvOffline.c,
        total: drvTotal.c,
        onlineSocket: driversOnlineSocket,
      },
      trips: {
        active: tripsActive.c,
        waiting: tripsWaiting.c,
        completedToday: tripsTodayCompleted.c,
        completed: tripsCompleted.c,
        total: tripsTotal.c,
      },
      scooters: {
        available: scAvail.c,
        inUse: scInUse.c,
        maintenance: scMaint.c,
        total: scTotal.c,
        activeTrips: scooterTripsActive.c,
      },
      system: {
        cpuPercent,
        memoryUsedMB: memUsedMB,
        memoryTotalMB: memTotalMB,
        rssMB,
        externalMB,
        socketClients,
        driversOnlineSocket,
      },
      performance: {
        avgResponseMs,
        p95ResponseMs,
        minResponseMs,
        maxResponseMs,
        sampledRequests: responseTimes.length,
      },
      database: {
        sizeKB: dbSizeKB,
        sizeMB: Math.round((dbSizeKB / 1024) * 100) / 100,
        walMode: true,
        status: 'connected',
      },
      backup: { last: lastBackup, count: backupCount },
      recentLogs,
      requestMetrics: {
        total: metrics.requestCount,
        error4xx: metrics.error4xxCount,
        error5xx: metrics.error5xxCount,
        slowRoutes: metrics.routes.slice(0, 5),
      },
      notifications: notifStats,
      recentErrors,
      recentCrashes,
    };
  }

  return {
    getStats,
    getDashboard,
    getRevenue,
    listUsers: () => userRepo.findAll(),
    getUser: (phone) => userRepo.findByPhone(phone),
    toggleUserActive: (phone, newStatus) => userRepo.setActive(phone, newStatus),
    listReports: () => reportRepo.findAll(100),
    resolveReport: (id) => reportRepo.resolve(id),
    addTaxi: (name, lat, lng) =>
      dbRun('INSERT INTO taxis (name, lat, lng, status) VALUES (?,?,?,?)', [
        name,
        lat,
        lng,
        'online',
      ]),
    deleteTaxi: (id) => dbRun('DELETE FROM taxis WHERE id = ?', [id]),
    listTripsPaginated: async (page, limit, status) =>
      (await tripRepo.findPaginated(page, limit, status)).map(formatTrip),
    countTrips: (status) => tripRepo.count(status),
    findTrip: (id) => tripRepo.findById(id),
    cancelTripByAdmin: (id) => tripRepo.cancelByAdmin(id),
    setDriverTaxiOnline: (driverId) => driverRepo.setTaxiStatus(driverId, 'online'),
    emitTripCancelled: (trip, id) =>
      io.to(`trip:${id}`).emit('trip:updated', { ...formatTrip(trip), status: 'cancelled' }),
  };
}

module.exports = { createAdminRepositoryAdapter };
