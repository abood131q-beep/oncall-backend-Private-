import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { adminApi, publicApi } from "../http-client.js";

export function registerAdminTools(server: McpServer): void {
  // ─── 1. get_admin_stats ──────────────────────────────────────
  server.tool(
    "get_admin_stats",
    "Get a comprehensive dashboard snapshot: total/active trips, total/online drivers, total users, revenue (total, today, this week), daily stats for the last 7 days, and top 5 drivers.",
    {},
    async () => {
      const response = await adminApi<Record<string, unknown>>("get", "/admin/stats");
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 2. get_analytics ────────────────────────────────────────
  server.tool(
    "get_analytics",
    "Get detailed analytics: daily revenue breakdown, monthly trends, top drivers, peak hours, and payment method distribution for the specified period.",
    {
      period: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Analysis period in days (default: 30, max: 365)"),
    },
    async ({ period }) => {
      const qs = period ? `?period=${period}` : "";
      const response = await adminApi<Record<string, unknown>>(
        "get",
        `/admin/analytics${qs}`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 3. get_revenue ──────────────────────────────────────────
  server.tool(
    "get_revenue",
    "Get revenue report: daily revenue for the last 30 days, total all-time revenue, and revenue for the current month.",
    {},
    async () => {
      const response = await adminApi<{
        success: boolean;
        daily: unknown[];
        total: number;
        month: number;
      }>("get", "/admin/revenue");
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 4. list_reports ─────────────────────────────────────────
  server.tool(
    "list_reports",
    "List all user-submitted reports/complaints (up to 100, newest first). Each report has a type, description, status (pending/resolved), and optional trip_id.",
    {},
    async () => {
      const response = await adminApi<unknown[]>("get", "/admin/reports");
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 5. resolve_report ───────────────────────────────────────
  server.tool(
    "resolve_report",
    "Mark a user report as resolved by its ID.",
    {
      id: z.number().int().positive().describe("The report's numeric ID"),
    },
    async ({ id }) => {
      const response = await adminApi<{ success: boolean }>(
        "put",
        `/admin/reports/${id}/resolve`
      );
      return {
        content: [
          {
            type: "text",
            text: response.success
              ? `Report #${id} marked as resolved.`
              : `Failed to resolve report #${id}.`,
          },
        ],
        isError: !response.success,
      };
    }
  );

  // ─── 6. toggle_user_status ───────────────────────────────────
  server.tool(
    "toggle_user_status",
    "Toggle a user's active status (block/unblock). If active → blocked; if blocked → active. Returns the new is_active value (1 = active, 0 = blocked).",
    {
      phone: z.string().min(3).describe("The user's phone number"),
    },
    async ({ phone }) => {
      const response = await adminApi<{ success: boolean; is_active: number }>(
        "put",
        `/admin/users/${encodeURIComponent(phone)}/toggle`
      );
      if (!response.success) {
        return {
          content: [{ type: "text", text: `User not found: ${phone}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `User ${phone} is now ${response.is_active ? "active ✅" : "blocked 🚫"}`,
          },
        ],
      };
    }
  );

  // ─── 7. toggle_driver_status ─────────────────────────────────
  server.tool(
    "toggle_driver_status",
    "Toggle a driver's active status (block/unblock). Blocking a driver also sets their status to offline. Returns the new is_active value.",
    {
      phone: z.string().min(3).describe("The driver's phone number"),
    },
    async ({ phone }) => {
      const response = await adminApi<{ success: boolean; is_active: number }>(
        "put",
        `/admin/drivers/${encodeURIComponent(phone)}/toggle`
      );
      if (!response.success) {
        return {
          content: [{ type: "text", text: `Driver not found: ${phone}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Driver ${phone} is now ${response.is_active ? "active ✅" : "blocked 🚫"}`,
          },
        ],
      };
    }
  );

  // ─── 8. list_backups ─────────────────────────────────────────
  server.tool(
    "list_backups",
    "List all available database backup files with their names, sizes, and creation dates.",
    {},
    async () => {
      const response = await adminApi<{ backups: unknown[] }>("get", "/admin/backups");
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 9. create_backup ────────────────────────────────────────
  server.tool(
    "create_backup",
    "Create a new database backup right now. Returns the backup filename and size.",
    {},
    async () => {
      const response = await adminApi<{ success: boolean; backup?: unknown; message?: string }>(
        "post",
        "/admin/backup"
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 10. get_server_health ───────────────────────────────────
  server.tool(
    "get_server_health",
    "Get the server's current health status: uptime, memory usage, database connection, and number of active trips.",
    {},
    async () => {
      const response = await publicApi<Record<string, unknown>>("get", "/health");
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 11. get_dashboard ───────────────────────────────────────
  server.tool(
    "get_dashboard",
    `Get a real-time diagnostic dashboard of the entire OnCall system in one call. Returns:
- Server status, uptime, Node version
- Passengers online (active Socket.IO passenger rooms)
- Drivers: online / busy / offline / total
- Trips: active (accepted+in_progress) / waiting / total
- Scooters: available / in_use / maintenance / total
- Users total
- System: memory (used/total MB), RSS MB, CPU %, Socket.IO client count, avg response time (ms)
- Database: size in KB/MB, WAL mode
- Last backup: filename, date, size`,
    {},
    async () => {
      const response = await adminApi<Record<string, unknown>>("get", "/admin/dashboard");
      if (!response || (response as { success?: boolean }).success === false) {
        return {
          content: [{ type: "text", text: "Dashboard unavailable — server may be restarting." }],
          isError: true,
        };
      }

      // Pretty-print as a readable status board
      const r = response as {
        timestamp: string;
        server: { status: string; uptimeHuman: string; nodeVersion: string; port: number };
        passengers: { online: number };
        drivers: { online: number; busy: number; offline: number; total: number };
        trips: { active: number; waiting: number; total: number };
        scooters: { available: number; inUse: number; maintenance: number; total: number };
        users: { total: number };
        system: {
          memoryUsedMB: number; memoryTotalMB: number; rssMB: number;
          cpuPercent: number; socketClients: number; avgResponseMs: number;
        };
        database: { sizeKB: number; sizeMB: number };
        backup: { name: string; date: string; sizeKB: number } | null;
      };

      const lines = [
        "╔══════════════════════════════════════╗",
        "║       OnCall — Server Dashboard      ║",
        "╠══════════════════════════════════════╣",
        `║  🟢 Server Status   ${r.server.status.toUpperCase().padEnd(17)}║`,
        `║  ⏱  Uptime          ${r.server.uptimeHuman.padEnd(17)}║`,
        "╠══════════════════════════════════════╣",
        `║  👤 Passengers Online  ${String(r.passengers.online).padEnd(14)}║`,
        "╠══ Drivers ════════════════════════════╣",
        `║  🟢 Online          ${String(r.drivers.online).padEnd(17)}║`,
        `║  🚗 Busy            ${String(r.drivers.busy).padEnd(17)}║`,
        `║  ⚫ Offline         ${String(r.drivers.offline).padEnd(17)}║`,
        "╠══ Trips ══════════════════════════════╣",
        `║  🔥 Active          ${String(r.trips.active).padEnd(17)}║`,
        `║  ⏳ Waiting         ${String(r.trips.waiting).padEnd(17)}║`,
        `║  📊 Total           ${String(r.trips.total).padEnd(17)}║`,
        "╠══ Scooters ═══════════════════════════╣",
        `║  ✅ Available       ${String(r.scooters.available).padEnd(17)}║`,
        `║  🛴 In Use          ${String(r.scooters.inUse).padEnd(17)}║`,
        `║  🔧 Maintenance     ${String(r.scooters.maintenance).padEnd(17)}║`,
        "╠══ System ═════════════════════════════╣",
        `║  💾 Memory          ${`${r.system.memoryUsedMB}/${r.system.memoryTotalMB} MB`.padEnd(17)}║`,
        `║  🖥  CPU             ${`${r.system.cpuPercent}%`.padEnd(17)}║`,
        `║  🔌 Socket Clients  ${String(r.system.socketClients).padEnd(17)}║`,
        `║  ⚡ Avg Response    ${`${r.system.avgResponseMs}ms`.padEnd(17)}║`,
        "╠══ Database ═══════════════════════════╣",
        `║  🗄  DB Size         ${`${r.database.sizeKB} KB`.padEnd(17)}║`,
        `║  💿 Last Backup     ${(r.backup?.name?.slice(7, 26) ?? "none").padEnd(17)}║`,
        "╠══════════════════════════════════════╣",
        `║  🕐 ${r.timestamp.replace("T", " ").slice(0, 19).padEnd(33)}║`,
        "╚══════════════════════════════════════╝",
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: "\n---\nRaw JSON:\n" + JSON.stringify(response, null, 2) },
        ],
      };
    }
  );

  // ─── 12. list_taxis ──────────────────────────────────────────
  server.tool(
    "list_taxis",
    "List all taxis/hubs in the OnCall fleet with their name, location coordinates, and current status (online/offline).",
    {},
    async () => {
      const response = await publicApi<unknown[]>("get", "/taxis");
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 13. get_server_logs ─────────────────────────────────────
  server.tool(
    "get_server_logs",
    "Retrieve recent server log entries from the in-memory ring buffer. Optionally filter by level (INFO, WARN, ERROR, OK) and limit the number of entries returned.",
    {
      n: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Number of log entries to return (default: 50, max: 500)"),
      level: z
        .enum(["INFO", "WARN", "ERROR", "OK"])
        .optional()
        .describe("Filter by log level. Omit to return all levels."),
    },
    async ({ n, level }) => {
      const params = new URLSearchParams();
      if (n) params.set("n", String(n));
      if (level) params.set("level", level);
      const qs = params.toString();
      const response = await adminApi<{
        success: boolean;
        count: number;
        filter: { n: number; level: string };
        logs: unknown[];
      }>("get", `/admin/logs${qs ? "?" + qs : ""}`);
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 14. delete_taxi ─────────────────────────────────────────
  server.tool(
    "delete_taxi",
    "⚠️ Permanently delete a taxi/hub from the fleet by its ID. This action cannot be undone.",
    {
      id: z.number().int().positive().describe("The taxi's numeric ID to delete"),
    },
    async ({ id }) => {
      const response = await adminApi<{ success: boolean }>(
        "delete",
        `/admin/taxis/${id}`
      );
      return {
        content: [
          {
            type: "text",
            text: response.success
              ? `Taxi #${id} deleted successfully.`
              : `Failed to delete taxi #${id}.`,
          },
        ],
        isError: !response.success,
      };
    }
  );

  // ─── 15. add_taxi ────────────────────────────────────────────
  server.tool(
    "add_taxi",
    "Add a new taxi to the fleet. Returns the new taxi's ID.",
    {
      name: z.string().min(2).describe("Taxi display name (e.g. 'Taxi 004')"),
      lat: z
        .number()
        .min(-90)
        .max(90)
        .optional()
        .describe("Initial latitude (defaults to Kuwait City center)"),
      lng: z
        .number()
        .min(-180)
        .max(180)
        .optional()
        .describe("Initial longitude (defaults to Kuwait City center)"),
    },
    async ({ name, lat, lng }) => {
      const response = await adminApi<{ success: boolean; id: number }>(
        "post",
        "/admin/taxis",
        { name, lat, lng }
      );
      return {
        content: [
          {
            type: "text",
            text: response.success
              ? `Taxi '${name}' added successfully with ID: ${response.id}`
              : "Failed to add taxi.",
          },
        ],
        isError: !response.success,
      };
    }
  );
}
