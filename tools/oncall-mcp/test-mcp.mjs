import { spawn } from "child_process";

const server = spawn("node", ["dist/server.js"], {
  env: {
    ...process.env,
    ONCALL_BASE_URL: "http://localhost:3000",
    ONCALL_ADMIN_PHONE: "112",
  },
  cwd: new URL(".", import.meta.url).pathname,
});

let buffer = "";
const results = [];

server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      results.push(msg);
    } catch {}
  }
});

server.stderr.on("data", (d) => process.stderr.write(d));

function send(obj) {
  server.stdin.write(JSON.stringify(obj) + "\n");
}

async function waitForId(id, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = results.find((r) => r.id === id);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout waiting for response id=${id}`);
}

async function callTool(id, name, args) {
  send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return waitForId(id);
}

function ok(label, pass, extra) {
  console.log(`  ${pass ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
}

function parseContent(res) {
  const text = res.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return text; }
}

async function run() {
  // 1. Initialize
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  }});
  const initRes = await waitForId(1);
  ok("initialize handshake", initRes.result?.serverInfo?.name === "oncall-mcp");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // 2. tools/list
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsRes = await waitForId(2);
  const toolNames = toolsRes.result?.tools?.map((t) => t.name) ?? [];
  const expected = ["list_users","get_user_by_phone","list_drivers","get_driver_by_phone",
                    "list_scooters","get_scooter_by_id","create_taxi_request","get_taxi_request_status"];
  ok(`all 8 tools registered (${toolNames.length}/8)`, toolNames.length === 8);
  for (const t of expected) ok(`  tool: ${t}`, toolNames.includes(t));

  // 3. list_users (limit 3)
  const u = await callTool(10, "list_users", { limit: 3 });
  const users = parseContent(u);
  ok(`list_users returns array (got ${Array.isArray(users) ? users.length : "err"})`, Array.isArray(users), u.result?.isError ? u.result?.content?.[0]?.text : null);

  // 4. get_user_by_phone (use "112" — the admin we just logged in as)
  const u2 = await callTool(11, "get_user_by_phone", { phone: "112" });
  const user = parseContent(u2);
  ok(`get_user_by_phone finds phone=112`, user?.phone === "112", u2.result?.isError ? u2.result?.content?.[0]?.text : null);

  // 5. list_drivers (all — no status filter to avoid empty list)
  const d = await callTool(20, "list_drivers", { limit: 5 });
  const drivers = parseContent(d);
  ok(`list_drivers returns array (got ${Array.isArray(drivers) ? drivers.length : "err"})`, Array.isArray(drivers), d.result?.isError ? d.result?.content?.[0]?.text : null);

  // 5b. get_driver_by_phone (first driver in list or skip)
  if (Array.isArray(drivers) && drivers[0]?.phone) {
    const d2 = await callTool(21, "get_driver_by_phone", { phone: drivers[0].phone });
    const driver = parseContent(d2);
    ok(`get_driver_by_phone (${drivers[0].phone}) returns driver`, !!driver?.phone, d2.result?.isError ? d2.result?.content?.[0]?.text : null);
  }

  // 6. list_scooters (available)
  const s = await callTool(30, "list_scooters", { status: "available" });
  const scooters = parseContent(s);
  ok(`list_scooters (status=available) returns array (got ${Array.isArray(scooters) ? scooters.length : "err"})`, Array.isArray(scooters), s.result?.isError ? s.result?.content?.[0]?.text : null);

  // 7. get_scooter_by_id — pick first available or id=1
  const scooterId = Array.isArray(scooters) && scooters[0]?.id ? scooters[0].id : 1;
  const s2 = await callTool(31, "get_scooter_by_id", { id: scooterId });
  const scooter = parseContent(s2);
  ok(`get_scooter_by_id (id=${scooterId}) returns scooter`, !!scooter?.id, s2.result?.isError ? s2.result?.content?.[0]?.text : null);

  // 8. create_taxi_request
  const tr = await callTool(40, "create_taxi_request", {
    phone: "112",
    pickup: "الكويت مول",
    destination: "مطار الكويت الدولي",
    pickupLat: 29.3370,
    pickupLng: 47.9965,
    destLat: 29.2267,
    destLng: 47.9689,
  });
  const trip = parseContent(tr);
  ok(`create_taxi_request returns trip with id`, !!trip?.id, tr.result?.isError ? tr.result?.content?.[0]?.text : null);

  // 9. get_taxi_request_status
  if (trip?.id) {
    const ts = await callTool(41, "get_taxi_request_status", { id: trip.id });
    const tripStatus = parseContent(ts);
    ok(`get_taxi_request_status (id=${trip.id}) status=${tripStatus?.status}`, !!tripStatus?.status, ts.result?.isError ? ts.result?.content?.[0]?.text : null);
  }

  // 10. error case — unknown user
  const ue = await callTool(50, "get_user_by_phone", { phone: "000000" });
  ok("get_user_by_phone unknown phone → isError", ue.result?.isError === true);

  console.log("\nDone.");
  server.kill();
  process.exit(0);
}

run().catch((err) => { console.error(err.message); server.kill(); process.exit(1); });
