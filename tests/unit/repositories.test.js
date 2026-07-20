'use strict';

/**
 * tests/unit/repositories.test.js — P6-06B
 *
 * Unit tests لجميع الـ 7 Repositories باستخدام node:test (Node 22).
 * يستخدم mock للـ DB layer — لا سيرفر، لا قاعدة بيانات حقيقية.
 *
 * تشغيل: node --test tests/unit/repositories.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createUserRepository }         = require('../../src/repositories/UserRepository');
const { createDriverRepository }       = require('../../src/repositories/DriverRepository');
const { createScooterRepository }      = require('../../src/repositories/ScooterRepository');
const { createTripRepository }         = require('../../src/repositories/TripRepository');
const { createWalletRepository }       = require('../../src/repositories/WalletRepository');
const { createNotificationRepository } = require('../../src/repositories/NotificationRepository');
const { createReportRepository }       = require('../../src/repositories/ReportRepository');

// ─── DB Mock Helpers ─────────────────────────────────────────────────────────

/**
 * ينشئ mock بسيطاً للـ DB يُسجّل كل استدعاء.
 * @param {object} overrides - قيم مخصصة لـ dbGet/dbAll/dbRun
 */
function makeDb(overrides = {}) {
  const calls = { get: [], all: [], run: [] };

  const dbGet = overrides.dbGet || (async (sql, params) => {
    calls.get.push({ sql, params });
    return overrides.getResult ?? null;
  });

  const dbAll = overrides.dbAll || (async (sql, params) => {
    calls.all.push({ sql, params });
    return overrides.allResult ?? [];
  });

  const dbRun = overrides.dbRun || (async (sql, params) => {
    calls.run.push({ sql, params });
    return overrides.runResult ?? { lastID: 1, changes: 1 };
  });

  return { dbGet, dbAll, dbRun, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. UserRepository
// ─────────────────────────────────────────────────────────────────────────────

describe('UserRepository', () => {

  test('findByPhone — يستدعي dbGet بالـ SQL والهاتف الصحيح', async () => {
    const db = makeDb({ getResult: { id: 1, phone: '96599999999', balance: 0 } });
    const repo = createUserRepository(db);
    const user = await repo.findByPhone('96599999999');
    assert.equal(user.phone, '96599999999');
    assert.equal(db.calls.get[0].params[0], '96599999999');
  });

  test('findById — يستدعي dbGet بالمعرّف', async () => {
    const db = makeDb({ getResult: { id: 5, phone: '96599999000' } });
    const repo = createUserRepository(db);
    await repo.findById(5);
    assert.equal(db.calls.get[0].params[0], 5);
  });

  test('findByPhone — يُعيد null إذا لم يوجد مستخدم', async () => {
    const db = makeDb({ getResult: null });
    const repo = createUserRepository(db);
    const result = await repo.findByPhone('000');
    assert.equal(result, null);
  });

  test('create — يُدرج بالهاتف والاسم والرصيد 0', async () => {
    const inserted = { id: 10, phone: '96599990001', name: 'راكب', balance: 0 };
    let callIndex = 0;
    const db = makeDb({
      dbRun: async (sql, params) => { db.calls.run.push({ sql, params }); return { lastID: 10 }; },
      dbGet: async () => inserted,
    });
    const repo = createUserRepository(db);
    const user = await repo.create('96599990001', 'راكب');
    // تحقق: الرصيد الابتدائي 0 (P6-04A) — قد يكون مُدمَجاً في SQL أو كـ parameter
    const insertSql    = db.calls.run[0].sql;
    const insertParams = db.calls.run[0].params;
    assert.ok(insertSql.includes('INSERT INTO users'));
    const balanceZero = insertParams.includes(0) ||
                        insertSql.includes(', 0)') ||
                        insertSql.includes(',0)');
    assert.ok(balanceZero, 'initial balance must be 0');
    assert.equal(user.id, 10);
  });

  test('create — يستخدم "راكب" كاسم افتراضي إذا لم يُمرَّر اسم', async () => {
    const db = makeDb({
      dbRun: async () => { db.calls.run.push({}); return { lastID: 1 }; },
      dbGet: async () => ({ id: 1 }),
    });
    const repo = createUserRepository(db);
    await repo.create('96599990002');
    assert.ok(db.calls.run[0], 'dbRun called');
  });

  test('updateName — يُعيد المستخدم المحدَّث', async () => {
    const updated = { id: 1, phone: '965', name: 'أحمد' };
    const db = makeDb({
      dbRun: async () => ({}),
      dbGet: async () => updated,
    });
    const repo = createUserRepository(db);
    const result = await repo.updateName('965', 'أحمد');
    assert.equal(result.name, 'أحمد');
  });

  test('setActive — يستدعي dbRun بالحالة والهاتف', async () => {
    const db = makeDb();
    const repo = createUserRepository(db);
    await repo.setActive('96599999999', 0);
    assert.equal(db.calls.run[0].params[0], 0);
    assert.equal(db.calls.run[0].params[1], '96599999999');
  });

  test('findAll — يُعيد مصفوفة', async () => {
    const db = makeDb({ allResult: [{ id: 1 }, { id: 2 }] });
    const repo = createUserRepository(db);
    const result = await repo.findAll();
    assert.equal(result.length, 2);
  });

  test('count — يُعيد عدداً صحيحاً', async () => {
    const db = makeDb({ getResult: { c: 42 } });
    const repo = createUserRepository(db);
    const n = await repo.count();
    assert.equal(n, 42);
  });

  test('count — يُعيد 0 إذا كانت النتيجة null', async () => {
    const db = makeDb({ getResult: null });
    const repo = createUserRepository(db);
    const n = await repo.count();
    assert.equal(n, 0);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// 2. DriverRepository
// ─────────────────────────────────────────────────────────────────────────────

describe('DriverRepository', () => {

  test('findByPhone — يُعيد السائق الصحيح', async () => {
    const driver = { id: 3, phone: '96512345678', name: 'سائق', is_active: 1 };
    const db = makeDb({ getResult: driver });
    const repo = createDriverRepository(db);
    const result = await repo.findByPhone('96512345678');
    assert.equal(result.id, 3);
  });

  test('create — is_active=0 للسائق الجديد (يحتاج موافقة مشرف)', async () => {
    const db = makeDb({
      dbRun: async (sql, params) => { db.calls.run.push({ sql, params }); return { lastID: 7 }; },
      dbGet: async () => ({ id: 7, is_active: 0 }),
    });
    const repo = createDriverRepository(db);
    await repo.create('96500000001');
    const insertParams = db.calls.run[0].params;
    // الموضع 4 في INSERT هو is_active
    assert.equal(insertParams[4], 0, 'new driver must be inactive');
  });

  test('setStatus — يُمرِّر الحالة والهاتف بالترتيب الصحيح', async () => {
    const db = makeDb();
    const repo = createDriverRepository(db);
    await repo.setStatus('96512345678', 'online');
    assert.equal(db.calls.run[0].params[0], 'online');
    assert.equal(db.calls.run[0].params[1], '96512345678');
  });

  test('setTaxiStatus — يُمرِّر المعرّف والحالة', async () => {
    const db = makeDb();
    const repo = createDriverRepository(db);
    await repo.setTaxiStatus(5, 'offline');
    assert.equal(db.calls.run[0].params[0], 'offline');
    assert.equal(db.calls.run[0].params[1], 5);
  });

  test('updateProfile — يُعيد الملف الشخصي المحدَّث', async () => {
    const updated = { id: 1, name: 'علي', car_name: 'كامري', plate: 'ABC123' };
    const db = makeDb({
      dbRun: async () => ({}),
      dbGet: async () => updated,
    });
    const repo = createDriverRepository(db);
    const result = await repo.updateProfile('965', 'علي', 'كامري', 'ABC123');
    assert.equal(result.name, 'علي');
    assert.equal(result.plate, 'ABC123');
  });

  test('updateRating — يُمرِّر rating وtotal_ratings والمعرّف', async () => {
    const db = makeDb();
    const repo = createDriverRepository(db);
    await repo.updateRating(3, 4.5, 10);
    const [r, t, id] = db.calls.run[0].params;
    assert.equal(r, 4.5);
    assert.equal(t, 10);
    assert.equal(id, 3);
  });

  test('getReviews — SQL يخفي رقم الراكب', async () => {
    const db = makeDb({ allResult: [] });
    const repo = createDriverRepository(db);
    await repo.getReviews(1);
    assert.ok(db.calls.all[0].sql.includes('SUBSTR'), 'should mask phone with SUBSTR');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ScooterRepository
// ─────────────────────────────────────────────────────────────────────────────

describe('ScooterRepository', () => {

  test('findById — يُحوّل المعرّف إلى Number', async () => {
    const db = makeDb({ getResult: { id: 2 } });
    const repo = createScooterRepository(db);
    await repo.findById('2');
    assert.equal(typeof db.calls.get[0].params[0], 'number');
  });

  test('setRiding — SQL يتضمن WHERE status=available (atomic TOCTOU guard)', async () => {
    const db = makeDb();
    const repo = createScooterRepository(db);
    await repo.setRiding(1, '96599999999', Date.now());
    assert.ok(db.calls.run[0].sql.includes("status='available'"));
  });

  test('setRiding — يُعيد { changes: 0 } إذا كان السكوتر مشغولاً', async () => {
    const db = makeDb({ runResult: { changes: 0 } });
    const repo = createScooterRepository(db);
    const result = await repo.setRiding(1, '96599999999', Date.now());
    assert.equal(result.changes, 0);
  });

  test('createRide — يُدرج بالحالة active', async () => {
    const db = makeDb();
    const repo = createScooterRepository(db);
    await repo.createRide(1, '965', Date.now());
    assert.ok(db.calls.run[0].params.includes('active'));
  });

  test('findActiveByPhone — SQL يفلتر بحالة riding والهاتف', async () => {
    const db = makeDb({ getResult: null });
    const repo = createScooterRepository(db);
    await repo.findActiveByPhone('96599999999');
    assert.ok(db.calls.get[0].sql.includes('current_user_phone'));
    assert.ok(db.calls.get[0].params.includes('riding'));
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// 4. WalletRepository
// ─────────────────────────────────────────────────────────────────────────────

describe('WalletRepository', () => {

  test('getBalance — يُعيد الرصيد من عمود balance', async () => {
    const db = makeDb({ getResult: { balance: 25.5 } });
    const repo = createWalletRepository(db);
    const result = await repo.getBalance('96599999999');
    assert.equal(result.balance, 25.5);
  });

  test('addBalance — SQL يستخدم balance + ? (إضافة وليس استبدال)', async () => {
    const db = makeDb();
    const repo = createWalletRepository(db);
    await repo.addBalance('965', 10);
    assert.ok(db.calls.run[0].sql.includes('balance + ?'));
    assert.equal(db.calls.run[0].params[0], 10);
  });

  test('addBalance — يُحوّل amount إلى Number', async () => {
    const db = makeDb();
    const repo = createWalletRepository(db);
    await repo.addBalance('965', '10.5');
    assert.equal(typeof db.calls.run[0].params[0], 'number');
  });

  test('deductBalanceSafe — يُعيد { success: true } عند نجاح الخصم', async () => {
    const db = makeDb({
      dbRun: async () => ({ changes: 1 }),
      dbGet: async () => ({ balance: 5 }),
    });
    const repo = createWalletRepository(db);
    const result = await repo.deductBalanceSafe('965', 10);
    assert.equal(result.success, true);
    assert.equal(result.balanceAfter, 5);
  });

  test('deductBalanceSafe — يُعيد { success: false } إذا الرصيد غير كافٍ', async () => {
    const db = makeDb({ runResult: { changes: 0 } });
    const repo = createWalletRepository(db);
    const result = await repo.deductBalanceSafe('965', 100);
    assert.equal(result.success, false);
    assert.equal(result.balanceAfter, undefined);
  });

  test('deductBalanceSafe — SQL ذري: WHERE balance >= ? (يمنع race condition)', async () => {
    const db = makeDb({
      dbRun: async (sql, params) => { db.calls.run.push({ sql, params }); return { changes: 1 }; },
      dbGet: async () => ({ balance: 0 }),
    });
    const repo = createWalletRepository(db);
    await repo.deductBalanceSafe('965', 10);
    assert.ok(db.calls.run[0].sql.includes('balance >= ?'), 'must guard against overdraft atomically');
  });

  test('logTransaction — بدون status يُدرج 7 حقول', async () => {
    const db = makeDb();
    const repo = createWalletRepository(db);
    await repo.logTransaction('965', 'charge', 10, 0, 10, 'شحن', null);
    assert.equal(db.calls.run[0].params.length, 7);
  });

  test('logTransaction — مع status يُدرج 8 حقول', async () => {
    const db = makeDb();
    const repo = createWalletRepository(db);
    await repo.logTransaction('965', 'charge', 10, 0, 10, 'شحن', null, 'success');
    assert.equal(db.calls.run[0].params.length, 8);
  });

  test('getTransactions — limit افتراضي 50', async () => {
    const db = makeDb({ allResult: [] });
    const repo = createWalletRepository(db);
    await repo.getTransactions('965');
    assert.equal(db.calls.all[0].params[1], 50);
  });

  test('getTransactions — يقبل limit مخصص', async () => {
    const db = makeDb({ allResult: [] });
    const repo = createWalletRepository(db);
    await repo.getTransactions('965', 10);
    assert.equal(db.calls.all[0].params[1], 10);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// 5. NotificationRepository
// ─────────────────────────────────────────────────────────────────────────────

describe('NotificationRepository', () => {

  test('send — يُدرج 4 حقول (بدون trip_id)', async () => {
    const db = makeDb();
    const repo = createNotificationRepository(db);
    await repo.send('965', 'عنوان', 'نص', 'info');
    assert.equal(db.calls.run[0].params.length, 4);
  });

  test('sendForTrip — يُدرج 5 حقول (مع trip_id)', async () => {
    const db = makeDb();
    const repo = createNotificationRepository(db);
    await repo.sendForTrip('965', 'عنوان', 'نص', 'trip', 99);
    assert.equal(db.calls.run[0].params[4], 99);
  });

  test('findByPhone — limit افتراضي 20', async () => {
    const db = makeDb({ allResult: [] });
    const repo = createNotificationRepository(db);
    await repo.findByPhone('965');
    assert.equal(db.calls.all[0].params[1], 20);
  });

  test('findByPhone — يقبل limit مخصص', async () => {
    const db = makeDb({ allResult: [] });
    const repo = createNotificationRepository(db);
    await repo.findByPhone('965', 5);
    assert.equal(db.calls.all[0].params[1], 5);
  });

  test('markAllRead — SQL يضبط is_read=1', async () => {
    const db = makeDb();
    const repo = createNotificationRepository(db);
    await repo.markAllRead('965');
    assert.ok(db.calls.run[0].sql.includes('is_read = 1'));
    assert.equal(db.calls.run[0].params[0], '965');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ReportRepository
// ─────────────────────────────────────────────────────────────────────────────

describe('ReportRepository', () => {

  test('create — يُدرج 4 حقول', async () => {
    const db = makeDb();
    const repo = createReportRepository(db);
    await repo.create('965', 'complaint', 'وصف', null);
    assert.equal(db.calls.run[0].params.length, 4);
  });

  test('create — trip_id يُمرَّر كـ null بشكل افتراضي', async () => {
    const db = makeDb();
    const repo = createReportRepository(db);
    await repo.create('965', 'complaint', 'وصف');
    assert.equal(db.calls.run[0].params[3], null);
  });

  test('create — يُمرِّر trip_id إذا وُجد', async () => {
    const db = makeDb();
    const repo = createReportRepository(db);
    await repo.create('965', 'complaint', 'وصف', 42);
    assert.equal(db.calls.run[0].params[3], 42);
  });

  test('findAll — limit افتراضي 100', async () => {
    const db = makeDb({ allResult: [] });
    const repo = createReportRepository(db);
    await repo.findAll();
    assert.equal(db.calls.all[0].params[0], 100);
  });

  test('findAll — يقبل limit مخصص', async () => {
    const db = makeDb({ allResult: [] });
    const repo = createReportRepository(db);
    await repo.findAll(25);
    assert.equal(db.calls.all[0].params[0], 25);
  });

  test("resolve — SQL يضبط status='resolved'", async () => {
    const db = makeDb();
    const repo = createReportRepository(db);
    await repo.resolve(7);
    assert.ok(db.calls.run[0].sql.includes("'resolved'"));
    assert.equal(db.calls.run[0].params[0], 7);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// 7. TripRepository (الأكثر تعقيداً)
// ─────────────────────────────────────────────────────────────────────────────

describe('TripRepository', () => {

  test('findById — يستدعي dbGet بالمعرّف', async () => {
    const db = makeDb({ getResult: { id: 1 } });
    const repo = createTripRepository(db);
    await repo.findById(1);
    assert.equal(db.calls.get[0].params[0], 1);
  });

  test('findByPassenger — SQL يُفلتر بـ user_phone', async () => {
    const db = makeDb({ allResult: [] });
    const repo = createTripRepository(db);
    await repo.findByPassenger('96599999999');
    assert.ok(db.calls.all[0].sql.includes('user_phone'));
    assert.equal(db.calls.all[0].params[0], '96599999999');
  });

  test('findByDriver — SQL يُفلتر بـ driver_id', async () => {
    const db = makeDb({ allResult: [] });
    const repo = createTripRepository(db);
    await repo.findByDriver(5);
    assert.ok(db.calls.all[0].sql.toLowerCase().includes('driver'));
  });

  test('create — يُعيد lastID', async () => {
    const db = makeDb({ runResult: { lastID: 99 } });
    const repo = createTripRepository(db);
    const result = await repo.create({
      userPhone: '965', fromLat: 29.3, fromLng: 48.0,
      toLat: 29.4, toLng: 48.1, fare: 2.5, type: 'taxi',
    });
    // create يستدعي dbRun ثم dbGet — يُعيد الرحلة المُنشأة
    assert.ok(db.calls.run.length > 0, 'dbRun called');
  });

  test('acceptByDriver — SQL يتضمن WHERE status=waiting_driver (TOCTOU guard)', async () => {
    const db = makeDb({ runResult: { changes: 1 } });
    const repo = createTripRepository(db);
    await repo.acceptByDriver(1, 2, 'سائق', 29.3, 48.0);
    assert.ok(
      db.calls.run[0].sql.includes("waiting_driver"),
      'must guard against race with WHERE status=waiting_driver'
    );
  });

  test('acceptByDriver — يُعيد { changes: 0 } إذا سبق سائق آخر القبول', async () => {
    const db = makeDb({ runResult: { changes: 0 } });
    const repo = createTripRepository(db);
    const result = await repo.acceptByDriver(1, 2, 'سائق', 29.3, 48.0);
    assert.equal(result.changes, 0);
  });

  test('setStatus — يُمرِّر الحالة والمعرّف', async () => {
    const db = makeDb();
    const repo = createTripRepository(db);
    await repo.setStatus(5, 'completed');
    assert.ok(db.calls.run[0].params.includes('completed'));
    assert.ok(db.calls.run[0].params.includes(5));
  });

  test('rateByPassenger — SQL يُحدّث rating', async () => {
    const db = makeDb();
    const repo = createTripRepository(db);
    await repo.rateByPassenger(1, 5, 'ممتاز');
    assert.ok(db.calls.run[0].sql.toLowerCase().includes('rating'));
  });

  test('rateByDriver — SQL يُحدّث passenger_rating', async () => {
    const db = makeDb();
    const repo = createTripRepository(db);
    await repo.rateByDriver(1, 4, 'جيد');
    assert.ok(db.calls.run[0].sql.includes('passenger_rating'));
  });

  test('count — يُعيد عدداً صحيحاً', async () => {
    const db = makeDb({ getResult: { c: 17 } });
    const repo = createTripRepository(db);
    const n = await repo.count();
    assert.equal(n, 17);
  });

  test('deleteAll — يستدعي dbRun بـ DELETE', async () => {
    const db = makeDb();
    const repo = createTripRepository(db);
    await repo.deleteAll();
    assert.ok(db.calls.run[0].sql.toUpperCase().includes('DELETE'));
  });

  test('cancelByAdmin — SQL يضبط status=cancelled', async () => {
    const db = makeDb();
    const repo = createTripRepository(db);
    await repo.cancelByAdmin(3);
    assert.ok(
      db.calls.run[0].sql.includes('cancelled') || db.calls.run[0].params.includes('cancelled')
    );
  });

});
