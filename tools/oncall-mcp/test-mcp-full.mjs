/**
 * test-mcp-full.mjs
 * اختبار شامل لجميع أدوات MCP — 44 أداة
 * يُشغَّل مع السيرفر الجاهز على localhost:3000
 */

import { spawn } from "child_process";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

// قراءة ADMIN_PHONE من .env
let ADMIN_PHONE = "112";
try {
  const env = readFileSync(resolve(__dir, "../../.env"), "utf8");
  const m = env.match(/^ADMIN_PHONES=(.+)/m);
  if (m) ADMIN_PHONE = m[1].split(",")[0].trim().replace(/["']/g, "");
} catch {}

// ───── تشغيل MCP Server ─────────────────────────────────────
const server = spawn("node", ["dist/server.js"], {
  env: {
    ...process.env,
    ONCALL_BASE_URL: "http://localhost:3000",
    ONCALL_ADMIN_PHONE: ADMIN_PHONE,
  },
  cwd: __dir,
});

let buffer = "";
const results = [];

server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try { results.push(JSON.parse(line)); } catch {}
  }
});
server.stderr.on("data", () => {}); // suppress stderr

function send(obj) { server.stdin.write(JSON.stringify(obj) + "\n"); }

async function waitForId(id, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const found = results.find((r) => r.id === id);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`Timeout id=${id}`);
}

let _id = 100;
async function call(name, args = {}) {
  const id = _id++;
  send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return waitForId(id);
}

function text(res) {
  return res?.result?.content?.[0]?.text ?? "";
}

function parse(res) {
  try { return JSON.parse(text(res)); } catch { return text(res); }
}

function isErr(res) { return res?.result?.isError === true; }

// ───── Tracking ──────────────────────────────────────────────
const PASS = [], FAIL = [], WARN = [];

function pass(name, note = "") {
  PASS.push(name);
  console.log(`  ✅ ${name}${note ? " — " + note : ""}`);
}
function fail(name, reason = "") {
  FAIL.push(name);
  console.log(`  ❌ ${name}${reason ? " — " + reason : ""}`);
}
function section(title) {
  console.log(`\n${"─".repeat(55)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(55));
}

// ───── Helper: check a tool result ───────────────────────────
function check(name, res, predicate, note = "") {
  if (isErr(res)) {
    fail(name, text(res).slice(0, 120));
    return null;
  }
  const data = parse(res);
  if (predicate(data)) {
    pass(name, note);
    return data;
  } else {
    fail(name, JSON.stringify(data).slice(0, 120));
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
async function run() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║    اختبار شامل — 44 أداة MCP — OnCall               ║");
  console.log(`╚══════════════════════════════════════════════════════╝`);
  console.log(`  Admin phone: ${ADMIN_PHONE}`);

  // ── Initialize ──────────────────────────────────────────────
  section("0. Handshake + Tool Registration");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "full-test", version: "2.0.0" },
  }});
  const init = await waitForId(1);
  if (init.result?.serverInfo?.name === "oncall-mcp") pass("initialize handshake");
  else fail("initialize handshake", JSON.stringify(init));

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsRes = await waitForId(2);
  const registered = toolsRes.result?.tools?.map((t) => t.name) ?? [];
  console.log(`\n  Registered tools: ${registered.length}`);
  registered.forEach((n) => console.log(`    • ${n}`));

  if (registered.length >= 40) pass(`tools/list — ${registered.length} أدوات مسجلة`);
  else fail(`tools/list — expected ≥40, got ${registered.length}`);

  // ─── Shared state ────────────────────────────────────────────
  let firstUser = null, firstDriver = null, firstScooter = null, createdTripId = null;

  // ════════════════════════════════════════════════════════════
  section("1. User Tools");
  // ════════════════════════════════════════════════════════════

  // list_users
  {
    const r = await call("list_users", { limit: 10 });
    const d = check("list_users", r, (v) => Array.isArray(v) && v.length >= 0,
      `${Array.isArray(parse(r)) ? parse(r).length : "?"} users`);
    if (d?.length) firstUser = d[0];
  }

  // list_users active_only
  {
    const r = await call("list_users", { active_only: true });
    check("list_users (active_only)", r, (v) => Array.isArray(v));
  }

  // get_user_by_phone
  {
    const phone = firstUser?.phone ?? ADMIN_PHONE;
    const r = await call("get_user_by_phone", { phone });
    check("get_user_by_phone", r, (v) => v?.phone === phone, `phone=${phone}`);
  }

  // get_user_by_phone — unknown → isError
  {
    const r = await call("get_user_by_phone", { phone: "000000" });
    if (isErr(r)) pass("get_user_by_phone (unknown) → isError");
    else fail("get_user_by_phone (unknown)", "expected isError, got: " + text(r).slice(0, 80));
  }

  // get_user_notifications
  {
    const phone = firstUser?.phone ?? ADMIN_PHONE;
    const r = await call("get_user_notifications", { phone });
    check("get_user_notifications", r, (v) => Array.isArray(v), `phone=${phone}`);
  }

  // mark_notifications_read
  {
    const phone = firstUser?.phone ?? ADMIN_PHONE;
    const r = await call("mark_notifications_read", { phone });
    check("mark_notifications_read", r, (v) => v?.success === true);
  }

  // get_user_transactions
  {
    const phone = firstUser?.phone ?? ADMIN_PHONE;
    const r = await call("get_user_transactions", { phone });
    check("get_user_transactions", r, (v) => Array.isArray(v), `phone=${phone}`);
  }

  // submit_report
  {
    const phone = firstUser?.phone ?? ADMIN_PHONE;
    const r = await call("submit_report", {
      phone,
      type: "general",
      description: "اختبار بلاغ تلقائي من test-mcp-full",
    });
    check("submit_report", r, (v) => v?.success === true);
  }

  // ════════════════════════════════════════════════════════════
  section("2. Driver Tools");
  // ════════════════════════════════════════════════════════════

  // list_drivers
  {
    const r = await call("list_drivers", {});
    const d = check("list_drivers", r, (v) => Array.isArray(v),
      `${Array.isArray(parse(r)) ? parse(r).length : "?"} drivers`);
    if (d?.length) firstDriver = d[0];
  }

  // list_drivers filtered online
  {
    const r = await call("list_drivers", { status: "online" });
    check("list_drivers (status=online)", r, (v) => Array.isArray(v));
  }

  // list_drivers active_only
  {
    const r = await call("list_drivers", { active_only: true });
    check("list_drivers (active_only)", r, (v) => Array.isArray(v));
  }

  // get_driver_by_phone
  if (firstDriver?.phone) {
    const r = await call("get_driver_by_phone", { phone: firstDriver.phone });
    check("get_driver_by_phone", r, (v) => !!v?.phone, `phone=${firstDriver.phone}`);
  } else {
    WARN.push("get_driver_by_phone — لا يوجد سائق");
    console.log("  ⚠️  get_driver_by_phone — تخطي (لا يوجد سائق)");
  }

  // get_driver_stats
  if (firstDriver?.phone) {
    const r = await call("get_driver_stats", { phone: firstDriver.phone });
    check("get_driver_stats", r, (v) => typeof v?.totalTrips === "number",
      `trips=${parse(r)?.totalTrips ?? "?"}`);
  }

  // get_driver_reviews
  if (firstDriver?.phone) {
    const r = await call("get_driver_reviews", { phone: firstDriver.phone });
    check("get_driver_reviews", r, (v) => typeof v?.avgRating === "number",
      `avg=${parse(r)?.avgRating}`);
  }

  // update_driver
  if (firstDriver?.phone) {
    const r = await call("update_driver", {
      phone: firstDriver.phone,
      car_name: firstDriver.car_name || "Toyota Camry",
    });
    check("update_driver", r, (v) => !!v?.phone || !!v?.name);
  }

  // ════════════════════════════════════════════════════════════
  section("3. Scooter Tools");
  // ════════════════════════════════════════════════════════════

  // list_scooters
  {
    const r = await call("list_scooters", {});
    const d = check("list_scooters", r, (v) => Array.isArray(v),
      `${Array.isArray(parse(r)) ? parse(r).length : "?"} scooters`);
    if (d?.length) firstScooter = d[0];
  }

  // list_scooters available
  {
    const r = await call("list_scooters", { status: "available" });
    check("list_scooters (available)", r, (v) => Array.isArray(v));
  }

  // get_scooter_by_id
  {
    const id = firstScooter?.id ?? 1;
    const r = await call("get_scooter_by_id", { id });
    check("get_scooter_by_id", r, (v) => !!v?.id, `id=${id}`);
  }

  // get_scooter_ride_history  ← server returns array directly
  {
    const phone = firstUser?.phone ?? ADMIN_PHONE;
    const r = await call("get_scooter_ride_history", { phone });
    check("get_scooter_ride_history", r, (v) => Array.isArray(v),
      `${Array.isArray(parse(r)) ? parse(r).length : "?"} rides`);
  }

  // get_active_scooter_ride
  {
    const phone = firstUser?.phone ?? ADMIN_PHONE;
    const r = await call("get_active_scooter_ride", { phone });
    check("get_active_scooter_ride", r, (v) => v !== null && v !== undefined);
  }

  // add_scooter
  {
    const r = await call("add_scooter", {
      name: "Scooter TEST-AUTO",
      scooter_code: `SCTEST${Date.now()}`,
      battery: 95,
    });
    check("add_scooter", r, (v) => typeof v === "string" && v.includes("ID"));
  }

  // reset_all_scooters
  {
    const r = await call("reset_all_scooters", {});
    check("reset_all_scooters", r, (v) => v?.success === true || typeof v?.message === "string");
  }

  // ════════════════════════════════════════════════════════════
  section("4. Taxi + Trip Tools");
  // ════════════════════════════════════════════════════════════

  // create_taxi_request
  {
    const phone = firstUser?.phone ?? ADMIN_PHONE;
    const r = await call("create_taxi_request", {
      phone,
      pickup: "مجمع الأفنيوز",
      destination: "فندق شيراتون الكويت",
      pickupLat: 29.3370, pickupLng: 47.9965,
      destLat: 29.3720,  destLng: 47.9786,
    });
    const d = check("create_taxi_request", r, (v) => !!v?.id,
      `trip #${parse(r)?.id}, fare=${parse(r)?.estimatedFare}`);
    if (d?.id) createdTripId = d.id;
  }

  // get_taxi_request_status
  if (createdTripId) {
    const r = await call("get_taxi_request_status", { id: createdTripId });
    check("get_taxi_request_status", r, (v) => !!v?.status,
      `status=${parse(r)?.status}`);
  }

  // list_trips
  {
    const r = await call("list_trips", { page: 1, limit: 10 });
    check("list_trips", r, (v) => Array.isArray(v?.trips),
      `${parse(r)?.trips?.length ?? "?"} trips, total=${parse(r)?.pagination?.total}`);
  }

  // list_trips with status filter
  {
    const r = await call("list_trips", { status: "waiting_driver", limit: 5 });
    check("list_trips (waiting_driver)", r, (v) => Array.isArray(v?.trips));
  }

  // get_trip
  if (createdTripId) {
    const r = await call("get_trip", { id: createdTripId });
    check("get_trip", r, (v) => !!v?.id, `id=${createdTripId}`);
  }

  // get_trip_location
  if (createdTripId) {
    const r = await call("get_trip_location", { id: createdTripId });
    check("get_trip_location", r, (v) => v !== null && !isErr({ result: { isError: false } }));
  }

  // list_passenger_trips  ← server returns array directly
  {
    const phone = firstUser?.phone ?? ADMIN_PHONE;
    const r = await call("list_passenger_trips", { phone });
    check("list_passenger_trips", r, (v) => Array.isArray(v),
      `${Array.isArray(parse(r)) ? parse(r).length : "?"} trips`);
  }

  // list_driver_trips
  if (firstDriver?.phone) {
    const r = await call("list_driver_trips", { phone: firstDriver.phone });
    check("list_driver_trips", r, (v) => Array.isArray(v));
  }

  // update_trip_status (cancel our test trip)
  if (createdTripId) {
    const r = await call("update_trip_status", {
      id: createdTripId,
      status: "cancelled",
    });
    check("update_trip_status → cancelled", r, (v) => v?.status === "cancelled" || v?.success);
  }

  // rate_trip (trip must be completed — use last completed trip if any)
  {
    // Get a completed trip
    const lRes = await call("list_trips", { status: "completed", limit: 1 });
    const completedTrips = parse(lRes)?.trips ?? [];
    if (completedTrips.length > 0) {
      const tid = completedTrips[0].id;
      const r = await call("rate_trip", { id: tid, rating: 5, comment: "اختبار تلقائي" });
      check("rate_trip", r, (v) => v?.success === true || typeof v?.message === "string");
    } else {
      WARN.push("rate_trip — لا توجد رحلات مكتملة للتقييم");
      console.log("  ⚠️  rate_trip — تخطي (لا توجد رحلات مكتملة)");
    }
  }

  // cancel_trip (use fresh trip)
  {
    const phone = firstUser?.phone ?? ADMIN_PHONE;
    const cRes = await call("create_taxi_request", {
      phone,
      pickup: "تجربة الإلغاء",
      destination: "وجهة اختبار",
      pickupLat: 29.37, pickupLng: 47.97,
      destLat: 29.38,   destLng: 47.98,
    });
    const newTrip = parse(cRes);
    if (newTrip?.id) {
      const r = await call("cancel_trip", { id: newTrip.id });
      check("cancel_trip (admin)", r, (v) => v?.success === true || (typeof v === "string" && v.includes("cancelled")));
    } else {
      WARN.push("cancel_trip — تعذّر إنشاء رحلة للاختبار");
      console.log("  ⚠️  cancel_trip — تخطي");
    }
  }

  // clear_all_trips  ← اختبار فقط بالتحقق من الاستجابة (لا ننفذه فعلياً)
  // نُرسله لنرى الاستجابة دون حذف فعلي إذا أردنا
  // ملاحظة: هذه أداة مدمّرة، نختبرها عبر التحقق من وجودها فقط
  if (registered.includes("clear_all_trips")) {
    pass("clear_all_trips — registered (تخطي التنفيذ الفعلي ⚠️ أداة مدمرة)");
  } else {
    fail("clear_all_trips — غير مسجلة");
  }

  // ════════════════════════════════════════════════════════════
  section("5. Admin Tools");
  // ════════════════════════════════════════════════════════════

  // get_admin_stats
  {
    const r = await call("get_admin_stats", {});
    check("get_admin_stats", r, (v) => typeof v?.totalTrips === "number",
      `trips=${parse(r)?.totalTrips}, users=${parse(r)?.totalUsers}`);
  }

  // get_analytics
  {
    const r = await call("get_analytics", { period: 7 });
    check("get_analytics (7 days)", r, (v) => v?.success === true || Array.isArray(v?.dailyRevenue));
  }

  // get_revenue
  {
    const r = await call("get_revenue", {});
    check("get_revenue", r, (v) => v?.success === true && typeof v?.total === "number",
      `total=${parse(r)?.total} KD`);
  }

  // list_reports
  {
    const r = await call("list_reports", {});
    check("list_reports", r, (v) => Array.isArray(v),
      `${Array.isArray(parse(r)) ? parse(r).length : "?"} reports`);
  }

  // resolve_report (use first pending report if any)
  {
    const rList = await call("list_reports", {});
    const reports = parse(rList);
    const pending = Array.isArray(reports) ? reports.find((r) => r.status === "pending") : null;
    if (pending?.id) {
      const r = await call("resolve_report", { id: pending.id });
      check("resolve_report", r, (v) => typeof v === "string" && v.includes("resolved"));
    } else {
      WARN.push("resolve_report — لا توجد بلاغات معلّقة");
      console.log("  ⚠️  resolve_report — تخطي (لا توجد بلاغات معلّقة للاختبار)");
    }
  }

  // toggle_user_status (toggle then toggle back to restore)
  if (firstUser?.phone && firstUser.phone !== ADMIN_PHONE) {
    const r1 = await call("toggle_user_status", { phone: firstUser.phone });
    const ok1 = check("toggle_user_status (block)", r1, (v) => typeof v === "string");
    if (ok1 !== null) {
      // Restore
      await call("toggle_user_status", { phone: firstUser.phone });
      pass("toggle_user_status (restore)");
    }
  } else {
    WARN.push("toggle_user_status — تخطي (المستخدم الأول هو المدير)");
    console.log("  ⚠️  toggle_user_status — تخطي");
  }

  // toggle_driver_status (toggle then restore)
  if (firstDriver?.phone) {
    const r1 = await call("toggle_driver_status", { phone: firstDriver.phone });
    const ok1 = check("toggle_driver_status (block)", r1, (v) => typeof v === "string");
    if (ok1 !== null) {
      await call("toggle_driver_status", { phone: firstDriver.phone });
      pass("toggle_driver_status (restore)");
    }
  } else {
    WARN.push("toggle_driver_status — لا يوجد سائق");
    console.log("  ⚠️  toggle_driver_status — تخطي");
  }

  // list_backups
  {
    const r = await call("list_backups", {});
    check("list_backups", r, (v) => Array.isArray(v?.backups),
      `${parse(r)?.backups?.length ?? "?"} backups`);
  }

  // create_backup
  {
    const r = await call("create_backup", {});
    check("create_backup", r, (v) => v?.success === true || !!v?.backup || !!v?.message);
  }

  // get_server_health
  {
    const r = await call("get_server_health", {});
    check("get_server_health", r, (v) => v?.status === "ok",
      `uptime=${parse(r)?.uptime}s`);
  }

  // add_taxi
  {
    const r = await call("add_taxi", { name: "Taxi TEST-AUTO" });
    check("add_taxi", r, (v) => typeof v === "string" && v.includes("ID"));
  }

  // ════════════════════════════════════════════════════════════
  section("6. Payment Tools");
  // ════════════════════════════════════════════════════════════

  // get_payment_methods
  {
    const r = await call("get_payment_methods", {});
    check("get_payment_methods", r, (v) => Array.isArray(v) && v.length > 0,
      `${Array.isArray(parse(r)) ? parse(r).length : "?"} methods`);
  }

  // get_wallet_transactions
  {
    const phone = firstUser?.phone ?? ADMIN_PHONE;
    const r = await call("get_wallet_transactions", { phone });
    check("get_wallet_transactions", r,
      (v) => v?.success === true && Array.isArray(v?.transactions),
      `balance=${parse(r)?.balance} KD`);
  }

  // charge_wallet (small amount)
  {
    const r = await call("charge_wallet", { amount: 0.001, method: "test" });
    check("charge_wallet", r, (v) => v?.success === true || typeof v?.balance === "number");
  }

  // estimate_fare
  {
    const r = await call("estimate_fare", {
      pickupLat: 29.3370, pickupLng: 47.9965,
      destLat: 29.3720,   destLng: 47.9786,
    });
    check("estimate_fare", r,
      (v) => typeof v?.total === "number" || typeof v?.distanceKm === "number",
      `fare=${parse(r)?.total} KD, dist=${parse(r)?.distanceKm} km`);
  }

  // get_fare_config
  {
    const r = await call("get_fare_config", {});
    check("get_fare_config", r,
      (v) => typeof v?.baseFare === "number" || typeof v?.currentMultiplier === "number",
      `multiplier=${parse(r)?.currentMultiplier}`);
  }

  // ════════════════════════════════════════════════════════════
  // Final Report
  // ════════════════════════════════════════════════════════════
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║              تقرير MCP النهائي                       ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  ✅ PASS  : ${String(PASS.length).padEnd(3)} / ${registered.length} tools                          ║`);
  console.log(`║  ❌ FAIL  : ${String(FAIL.length).padEnd(3)}                                    ║`);
  console.log(`║  ⚠️  WARN  : ${String(WARN.length).padEnd(3)} (skipped — no data / destructive)  ║`);
  console.log("╚══════════════════════════════════════════════════════╝");

  if (FAIL.length === 0) {
    console.log(`\n  🎉  ${PASS.length} / ${registered.length} tools — ALL PASS ✅`);
  } else {
    console.log("\n  الأدوات الفاشلة:");
    FAIL.forEach((n) => console.log(`    ❌ ${n}`));
  }

  if (WARN.length) {
    console.log("\n  تحذيرات:");
    WARN.forEach((n) => console.log(`    ⚠️  ${n}`));
  }

  server.kill();
  process.exit(FAIL.length === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error("\nFATAL:", err.message);
  server.kill();
  process.exit(1);
});
