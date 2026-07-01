import { z } from "zod";
import * as path from "path";
import * as childProcess from "child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { adminApi } from "../http-client.js";

// ── Shared dashboard response type ────────────────────────────────────────────
interface DashboardResponse {
  success: boolean;
  timestamp: string;
  server: {
    status: string;
    pid: number;
    platform: string;
    nodeVersion: string;
    port: number;
    uptime: number;
    uptimeHuman: string;
  };
  users: { total: number; activeToday: number };
  passengers: { online: number };
  drivers: { online: number; busy: number; offline: number; total: number; onlineSocket: number };
  trips: { active: number; waiting: number; completedToday: number; completed: number; total: number };
  scooters: { available: number; inUse: number; maintenance: number; total: number; activeTrips: number };
  system: {
    cpuPercent: number;
    memoryUsedMB: number;
    memoryTotalMB: number;
    rssMB: number;
    externalMB: number;
    socketClients: number;
  };
  performance: {
    avgResponseMs: number;
    p95ResponseMs: number;
    minResponseMs: number;
    maxResponseMs: number;
    sampledRequests: number;
  };
  database: { sizeKB: number; sizeMB: number; walMode: boolean; status: string };
  backup: { last: { name: string; date: string; sizeKB: number } | null; count: number };
  recentLogs: Array<{ timestamp: string; level: string; msg: string; data: unknown }>;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Format bytes → human-readable (B / KB / MB / GB) */
function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(2)} KB`;
  return `${bytes} B`;
}

/** Horizontal rule */
const HR = "─".repeat(44);

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerEngineeringTools(server: McpServer): void {
  // ─── 2. tail_logs ────────────────────────────────────────────
  server.tool(
    "tail_logs",
    "Fetch the last N server log entries, optionally filtered by level (INFO | WARN | ERROR | OK). Returns a formatted log tail for debugging and monitoring. Default: last 50 entries, all levels.",
    {
      n: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Number of log entries to return (default: 50, max: 200)"),
      level: z
        .enum(["INFO", "WARN", "ERROR", "OK"])
        .optional()
        .describe("Filter by log level"),
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
        logs: Array<{ timestamp: string; level: string; msg: string; data: unknown }>;
      }>("get", `/admin/logs${qs ? "?" + qs : ""}`);

      if (!response.success || !response.logs) {
        return { content: [{ type: "text", text: "Failed to fetch logs" }], isError: true };
      }

      const header = `📋 Server Logs — last ${response.count} entries [filter: ${response.filter.level}]`;
      const lines = response.logs.map((e) => {
        const lvlIcon = e.level === "ERROR" ? "❌" : e.level === "WARN" ? "⚠️ " : e.level === "OK" ? "✅" : "ℹ️ ";
        const dataStr = e.data ? `  ${JSON.stringify(e.data)}` : "";
        return `${lvlIcon} [${e.timestamp}] ${e.msg}${dataStr}`;
      });

      return {
        content: [
          { type: "text", text: [header, HR, ...lines].join("\n") },
        ],
      };
    }
  );

  // ─── 19. engineering_dashboard ───────────────────────────────
  server.tool(
    "engineering_dashboard",
    "Comprehensive engineering overview in a single call: server health, system resources (CPU, memory, disk), database status, Socket.IO connections, API performance, backup status, and the last 10 log entries. The fastest way to get the full picture of the OnCall backend.",
    {},
    async () => {
      // Fetch dashboard + system in parallel
      const [d, sys] = await Promise.all([
        adminApi<DashboardResponse>("get", "/admin/dashboard"),
        adminApi<{
          success: boolean;
          node: { version: string; platform: string; arch: string; pid: number };
          memory: { heapUsedMB: number; heapTotalMB: number; rssMB: number; systemFreeMB: number; systemTotalMB: number; systemUsedPercent: number };
          cpu: { cores: number; model: string; loadAvg1m: number; loadAvg5m: number; loadAvg15m: number };
          disk: { totalGB: number; usedGB: number; freeGB: number; usedPercent: number };
          uptime: { human: string };
          env: { nodeEnv: string; port: number | string };
        }>("get", "/admin/system"),
      ]);

      const heapPct = Math.round(((sys.memory?.heapUsedMB ?? 0) / (sys.memory?.heapTotalMB || 1)) * 100);
      const diskBar = "█".repeat(Math.floor((sys.disk?.usedPercent ?? 0) / 5)) + "░".repeat(20 - Math.floor((sys.disk?.usedPercent ?? 0) / 5));

      const recentLogs = (d.recentLogs ?? []).slice(-10).map((e) => {
        const icon = e.level === "ERROR" ? "❌" : e.level === "WARN" ? "⚠️ " : e.level === "OK" ? "✅" : "ℹ️ ";
        return `  ${icon} [${e.timestamp}] ${e.msg}`;
      });

      const lines = [
        `╔══════════════════════════════════════════════╗`,
        `║          OnCall Engineering Dashboard        ║`,
        `║  ${d.timestamp ?? new Date().toISOString()}  ║`,
        `╚══════════════════════════════════════════════╝`,
        ``,
        `🖥  SERVER`,
        HR,
        `  Status   : ${(d.server?.status ?? "unknown").toUpperCase()} ✅  |  PID: ${d.server?.pid ?? "?"}`,
        `  Node.js  : ${sys.node?.version ?? "?"}  |  Platform: ${sys.node?.platform ?? "?"}`,
        `  Uptime   : ${d.server?.uptimeHuman ?? sys.uptime?.human ?? "?"}`,
        `  Env      : ${sys.env?.nodeEnv ?? "?"}  |  Port: ${sys.env?.port ?? 3000}`,
        ``,
        `💾 RESOURCES`,
        HR,
        `  Heap     : ${sys.memory?.heapUsedMB ?? 0}/${sys.memory?.heapTotalMB ?? 0} MB (${heapPct}%)  |  RSS: ${sys.memory?.rssMB ?? 0} MB`,
        `  RAM      : ${sys.memory?.systemUsedPercent ?? 0}% used  (${sys.memory?.systemFreeMB ?? 0} MB free / ${sys.memory?.systemTotalMB ?? 0} MB)`,
        `  CPU Load : ${sys.cpu?.loadAvg1m?.toFixed(2) ?? "?"} (1m)  ${sys.cpu?.loadAvg5m?.toFixed(2) ?? "?"} (5m)  |  ${sys.cpu?.cores ?? 0} cores`,
        `  Disk     : [${diskBar}] ${sys.disk?.usedPercent ?? 0}%  (${sys.disk?.freeGB ?? 0} GB free / ${sys.disk?.totalGB ?? 0} GB)`,
        ``,
        `🗄  DATABASE`,
        HR,
        `  Size     : ${d.database?.sizeMB ?? 0} MB  |  WAL: ${d.database?.walMode ? "✅" : "⚠️"}  |  Status: ${d.database?.status ?? "unknown"}`,
        `  Backups  : ${d.backup?.count ?? 0} files  |  Last: ${d.backup?.last?.name ?? "none"}`,
        ``,
        `🌐 CONNECTIONS & PERFORMANCE`,
        HR,
        `  Sockets  : ${d.system?.socketClients ?? 0} clients  |  Passengers: ${d.passengers?.online ?? 0}  |  Drivers: ${d.drivers?.online ?? 0}/${d.drivers?.total ?? 0}`,
        `  Trips    : ${d.trips?.active ?? 0} active  |  ${d.trips?.waiting ?? 0} waiting  |  ${d.trips?.completedToday ?? 0} done today`,
        `  Scooters : ${d.scooters?.available ?? 0} available  |  ${d.scooters?.inUse ?? 0} in use  |  ${d.scooters?.maintenance ?? 0} maintenance`,
        `  API Perf : avg ${d.performance?.avgResponseMs ?? 0} ms  |  p95 ${d.performance?.p95ResponseMs ?? 0} ms  |  ${d.performance?.sampledRequests ?? 0} samples`,
        ``,
        `📋 RECENT LOGS (last 10)`,
        HR,
        ...recentLogs,
        HR,
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: "\n---\nRaw JSON snapshot:\n" + JSON.stringify({ server: d.server, system: d.system, database: d.database, performance: d.performance, trips: d.trips, scooters: d.scooters }, null, 2) },
        ],
      };
    }
  );

  // ─── 17. start_server ────────────────────────────────────────
  server.tool(
    "start_server",
    "Start the OnCall backend server as a detached background process. Uses ONCALL_BACKEND_PATH env var (default: two directories above the MCP root). Returns the new PID if successful.",
    {},
    async () => {
      const backendPath = process.env.ONCALL_BACKEND_PATH
        ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

      return new Promise((resolve) => {
        try {
          const child = childProcess.spawn("node", ["server.js"], {
            cwd: backendPath,
            detached: true,
            stdio: "ignore",
          });
          child.unref();
          resolve({
            content: [{ type: "text", text: `✅ Backend server started (PID: ${child.pid}) from ${backendPath}` }],
          });
        } catch (err) {
          resolve({
            content: [{ type: "text", text: `❌ Failed to start server: ${(err as Error).message}` }],
            isError: true,
          });
        }
      });
    }
  );

  // ─── 18. restart_server ──────────────────────────────────────
  server.tool(
    "restart_server",
    "Gracefully stop the running OnCall backend server and immediately start a new instance. Combines stop_server + start_server. The new process is detached and runs in the background.",
    {},
    async () => {
      // 1. Send shutdown signal (best-effort — server may already be down)
      let stopMsg = "stopped";
      try {
        const s = await adminApi<{ success: boolean; message: string }>("post", "/admin/shutdown");
        stopMsg = s.message ?? "stopped";
        // brief pause for process.exit(0) to fire
        await new Promise((r) => setTimeout(r, 1500));
      } catch {
        stopMsg = "server was already down or unreachable";
      }

      // 2. Start new instance
      const backendPath = process.env.ONCALL_BACKEND_PATH
        ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

      return new Promise((resolve) => {
        try {
          const child = childProcess.spawn("node", ["server.js"], {
            cwd: backendPath,
            detached: true,
            stdio: "ignore",
          });
          child.unref();
          resolve({
            content: [{
              type: "text",
              text: `🔄 Restart complete\n  Stop: ${stopMsg}\n  Start: new process PID ${child.pid} from ${backendPath}`,
            }],
          });
        } catch (err) {
          resolve({
            content: [{ type: "text", text: `❌ Started shutdown but failed to start: ${(err as Error).message}` }],
            isError: true,
          });
        }
      });
    }
  );

  // ─── 14. verify_database ─────────────────────────────────────
  server.tool(
    "verify_database",
    "Run a full SQLite integrity check (PRAGMA integrity_check). Returns 'ok' if the database is intact, or a list of problems if corruption is detected. Use database_health for a broader status overview.",
    {},
    async () => {
      const r = await adminApi<{
        success: boolean; status: string; integrity: string; sizeKB: number; pageCount: number;
      }>("get", "/admin/db/health");

      const ok = r.integrity === "ok";
      const lines = [
        `🔍 Database Verification`,
        HR,
        `  Result     : ${ok ? "✅ PASSED — no corruption detected" : `❌ FAILED — ${r.integrity}`}`,
        `  Size       : ${r.sizeKB ?? 0} KB`,
        `  Pages      : ${r.pageCount ?? 0}`,
        HR,
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        isError: !ok,
      };
    }
  );

  // ─── 15. disk_usage ──────────────────────────────────────────
  server.tool(
    "disk_usage",
    "Get disk usage for the server's working directory: total, used, and free space in GB, plus usage percentage. Useful for monitoring storage capacity before large backups or imports.",
    {},
    async () => {
      const r = await adminApi<{
        success: boolean;
        disk: { totalGB: number; usedGB: number; freeGB: number; usedPercent: number };
      }>("get", "/admin/system");
      const d = r.disk;
      const bar = "█".repeat(Math.floor((d?.usedPercent ?? 0) / 5)) + "░".repeat(20 - Math.floor((d?.usedPercent ?? 0) / 5));
      const lines = [
        `💿 Disk Usage`,
        HR,
        `  [${bar}] ${d?.usedPercent ?? 0}%`,
        `  Total   : ${d?.totalGB ?? 0} GB`,
        `  Used    : ${d?.usedGB ?? 0} GB`,
        `  Free    : ${d?.freeGB ?? 0} GB`,
        HR,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ─── 16. database_restore ────────────────────────────────────
  server.tool(
    "database_restore",
    "⚠️ DANGER: Restore the database from a named backup file in the backups/ directory. A safety backup of the current database is created automatically before restoring. Get available backup names from list_backups.",
    {
      filename: z
        .string()
        .min(1)
        .regex(/^oncall_[\w\-]+\.db$/, "Must be a valid backup filename like oncall_2024-01-15T10-30-00.db")
        .describe("Backup filename to restore from (e.g. oncall_2024-01-15T10-30-00.db)"),
    },
    async ({ filename }) => {
      const r = await adminApi<{ success: boolean; message: string }>(
        "post",
        "/admin/db/restore",
        { filename }
      );
      return {
        content: [{ type: "text", text: r.success ? `✅ ${r.message}` : `❌ ${r.message ?? "Restore failed"}` }],
        isError: !r.success,
      };
    }
  );

  // ─── 13. stop_server ─────────────────────────────────────────
  server.tool(
    "stop_server",
    "⚠️ DANGER: Gracefully shut down the OnCall backend server. The server will stop accepting connections after 1 second. Use restart_server to bring it back up, or start it manually with: node server.js",
    {},
    async () => {
      const r = await adminApi<{ success: boolean; message: string }>("post", "/admin/shutdown");
      return {
        content: [{ type: "text", text: r.success ? `⚠️  ${r.message}` : `❌ Shutdown failed` }],
        isError: !r.success,
      };
    }
  );

  // ─── 12. environment_info ────────────────────────────────────
  server.tool(
    "environment_info",
    "Get Node.js runtime environment information: Node version, platform, architecture, PID, environment variables (NODE_ENV, PORT, timezone), and server uptime.",
    {},
    async () => {
      const r = await adminApi<{
        success: boolean;
        node: { version: string; platform: string; arch: string; pid: number };
        env: { nodeEnv: string; port: number | string; timezone: string };
        uptime: { seconds: number; human: string };
      }>("get", "/admin/system");
      const lines = [
        `⚙️  Environment Info`,
        HR,
        `  Node.js    : ${r.node?.version ?? "?"}`,
        `  Platform   : ${r.node?.platform ?? "?"} (${r.node?.arch ?? "?"})`,
        `  PID        : ${r.node?.pid ?? "?"}`,
        HR,
        `  NODE_ENV   : ${r.env?.nodeEnv ?? "?"}`,
        `  PORT       : ${r.env?.port ?? "?"}`,
        `  Timezone   : ${r.env?.timezone ?? "?"}`,
        HR,
        `  Uptime     : ${r.uptime?.human ?? "?"}`,
        HR,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ─── 9. memory_usage ─────────────────────────────────────────
  server.tool(
    "memory_usage",
    "Get detailed Node.js and OS memory usage: heap used/total, RSS, external memory, system free/total RAM, and usage percentage.",
    {},
    async () => {
      const r = await adminApi<{
        success: boolean;
        memory: { heapUsedMB: number; heapTotalMB: number; rssMB: number; externalMB: number; systemFreeMB: number; systemTotalMB: number; systemUsedPercent: number };
      }>("get", "/admin/system");
      const m = r.memory;
      const heapPct = Math.round(((m?.heapUsedMB ?? 0) / (m?.heapTotalMB || 1)) * 100);
      const lines = [
        `💾 Memory Usage`,
        HR,
        `  Heap Used  : ${m?.heapUsedMB ?? 0} MB / ${m?.heapTotalMB ?? 0} MB (${heapPct}%)`,
        `  RSS        : ${m?.rssMB ?? 0} MB`,
        `  External   : ${m?.externalMB ?? 0} MB`,
        HR,
        `  System RAM : ${m?.systemUsedPercent ?? 0}% used`,
        `  Free       : ${m?.systemFreeMB ?? 0} MB / ${m?.systemTotalMB ?? 0} MB`,
        HR,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ─── 10. network_status ──────────────────────────────────────
  server.tool(
    "network_status",
    "Get API performance metrics and Socket.IO connection stats: average/p95 response times, request sample count, and connected socket clients.",
    {},
    async () => {
      const d = await adminApi<DashboardResponse>("get", "/admin/dashboard");
      const lines = [
        `🌐 Network & API Status`,
        HR,
        `  Socket Clients : ${d.system?.socketClients ?? 0} connected`,
        HR,
        `  Avg Response   : ${d.performance?.avgResponseMs ?? 0} ms`,
        `  P95 Response   : ${d.performance?.p95ResponseMs ?? 0} ms`,
        `  Min Response   : ${d.performance?.minResponseMs ?? 0} ms`,
        `  Max Response   : ${d.performance?.maxResponseMs ?? 0} ms`,
        `  Samples        : ${d.performance?.sampledRequests ?? 0} requests`,
        HR,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ─── 11. socket_status ───────────────────────────────────────
  server.tool(
    "socket_status",
    "Get real-time Socket.IO connection status: total connected clients, online passengers, online/busy/offline driver counts, and active trip count.",
    {},
    async () => {
      const d = await adminApi<DashboardResponse>("get", "/admin/dashboard");
      const lines = [
        `🔌 Socket.IO Status`,
        HR,
        `  Connected Clients : ${d.system?.socketClients ?? 0}`,
        HR,
        `  Passengers Online : ${d.passengers?.online ?? 0}`,
        HR,
        `  Drivers Online    : ${d.drivers?.online ?? 0}`,
        `  Drivers Busy      : ${d.drivers?.busy ?? 0}`,
        `  Drivers Offline   : ${d.drivers?.offline ?? 0}`,
        `  Drivers (Socket)  : ${d.drivers?.onlineSocket ?? 0}`,
        HR,
        `  Active Trips      : ${d.trips?.active ?? 0}`,
        `  Waiting Trips     : ${d.trips?.waiting ?? 0}`,
        HR,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ─── 8. cpu_usage ────────────────────────────────────────────
  server.tool(
    "cpu_usage",
    "Get current CPU information: number of cores, CPU model, and 1/5/15-minute load averages from the OS.",
    {},
    async () => {
      const r = await adminApi<{
        success: boolean;
        cpu: { cores: number; model: string; loadAvg1m: number; loadAvg5m: number; loadAvg15m: number };
      }>("get", "/admin/system");
      const c = r.cpu;
      const lines = [
        `🔲 CPU Usage`,
        HR,
        `  Model      : ${c?.model ?? "unknown"}`,
        `  Cores      : ${c?.cores ?? 0}`,
        `  Load  1m   : ${c?.loadAvg1m?.toFixed(2) ?? "?"} (${Math.round(((c?.loadAvg1m ?? 0) / (c?.cores ?? 1)) * 100)}%)`,
        `  Load  5m   : ${c?.loadAvg5m?.toFixed(2) ?? "?"}`,
        `  Load 15m   : ${c?.loadAvg15m?.toFixed(2) ?? "?"}`,
        HR,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ─── 7. rebuild_indexes ──────────────────────────────────────
  server.tool(
    "rebuild_indexes",
    "Run SQLite REINDEX to rebuild all database indexes. Use this after bulk data operations or if queries are slower than expected. The operation rewrites all indexes from scratch.",
    {},
    async () => {
      const r = await adminApi<{ success: boolean; message: string }>("post", "/admin/db/reindex");
      return {
        content: [{ type: "text", text: r.success ? `✅ ${r.message}` : `❌ REINDEX failed` }],
        isError: !r.success,
      };
    }
  );

  // ─── 6. vacuum_database ──────────────────────────────────────
  server.tool(
    "vacuum_database",
    "Run SQLite VACUUM to compact and defragment the database file. This reclaims unused space and can significantly reduce file size. The operation may take a few seconds on large databases.",
    {},
    async () => {
      const r = await adminApi<{ success: boolean; message: string }>("post", "/admin/db/vacuum");
      return {
        content: [{ type: "text", text: r.success ? `✅ ${r.message}` : `❌ VACUUM failed` }],
        isError: !r.success,
      };
    }
  );

  // ─── 5. database_health ──────────────────────────────────────
  server.tool(
    "database_health",
    "Run SQLite PRAGMA integrity_check and return database health metrics: status (healthy/corrupted), page count, page size, total size, WAL mode, and journal mode.",
    {},
    async () => {
      const r = await adminApi<{
        success: boolean; status: string; integrity: string;
        pageCount: number; pageSize: number; sizeKB: number; sizeMB: number;
        journalMode: string; walCheckpoint: unknown;
      }>("get", "/admin/db/health");

      const icon = r.status === "healthy" ? "✅" : "❌";
      const lines = [
        `🗄  Database Health ${icon}`,
        HR,
        `  Status     : ${(r.status ?? "unknown").toUpperCase()} ${icon}`,
        `  Integrity  : ${r.integrity ?? "unknown"}`,
        `  Size       : ${r.sizeMB ?? 0} MB (${r.sizeKB ?? 0} KB)`,
        `  Pages      : ${r.pageCount ?? 0} × ${r.pageSize ?? 0} B`,
        `  Journal    : ${r.journalMode ?? "unknown"}`,
        HR,
      ];
      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: "\n---\nRaw JSON:\n" + JSON.stringify(r, null, 2) },
        ],
        isError: r.status !== "healthy",
      };
    }
  );

  // ─── 4. database_backup ──────────────────────────────────────
  server.tool(
    "database_backup",
    "Trigger an immediate SQLite database backup. Creates a timestamped .db copy in the backups/ directory. Returns success status.",
    {},
    async () => {
      const response = await adminApi<{ success: boolean; message?: string }>(
        "post",
        "/admin/backup"
      );
      return {
        content: [
          {
            type: "text",
            text: response.success
              ? `✅ Backup created successfully. ${response.message ?? ""}`
              : `❌ Backup failed.`,
          },
        ],
        isError: !response.success,
      };
    }
  );

  // ─── 3. clear_logs ───────────────────────────────────────────
  server.tool(
    "clear_logs",
    "Clear all in-memory server log entries and truncate the log file on disk. Use with caution — this cannot be undone. Returns how many entries were cleared.",
    {},
    async () => {
      const response = await adminApi<{ success: boolean; cleared: number; message: string }>(
        "post",
        "/admin/logs/clear"
      );
      if (!response.success) {
        return { content: [{ type: "text", text: "Failed to clear logs" }], isError: true };
      }
      return {
        content: [{ type: "text", text: `🗑️  Logs cleared — ${response.cleared} entries removed from memory and disk.` }],
      };
    }
  );

  // ─── 1. server_status ────────────────────────────────────────
  server.tool(
    "server_status",
    "Get a concise engineering status report: server state, PID, uptime, Node.js version, CPU, heap memory, database size/status, and API response times. Returns a human-readable summary plus raw JSON.",
    {},
    async () => {
      const d = await adminApi<DashboardResponse>("get", "/admin/dashboard");

      const lines = [
        `🖥  Server Status — ${d.timestamp ?? new Date().toISOString()}`,
        HR,
        `  State      : ${(d.server?.status ?? "unknown").toUpperCase()} ✅`,
        `  PID        : ${d.server?.pid ?? "?"}`,
        `  Uptime     : ${d.server?.uptimeHuman ?? "?"}`,
        `  Node.js    : ${d.server?.nodeVersion ?? "?"}`,
        `  Platform   : ${d.server?.platform ?? "?"}`,
        `  Port       : ${d.server?.port ?? 3000}`,
        HR,
        `  CPU        : ${d.system?.cpuPercent ?? 0}%`,
        `  Heap       : ${d.system?.memoryUsedMB ?? 0} / ${d.system?.memoryTotalMB ?? 0} MB`,
        `  RSS        : ${d.system?.rssMB ?? 0} MB`,
        HR,
        `  DB Size    : ${formatBytes((d.database?.sizeKB ?? 0) * 1024)}`,
        `  DB Status  : ${d.database?.status ?? "unknown"}`,
        `  DB WAL     : ${d.database?.walMode ? "enabled ✅" : "disabled ⚠️"}`,
        HR,
        `  Avg Resp   : ${d.performance?.avgResponseMs ?? 0} ms`,
        `  P95 Resp   : ${d.performance?.p95ResponseMs ?? 0} ms`,
        `  Samples    : ${d.performance?.sampledRequests ?? 0}`,
        HR,
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: "\n---\nRaw JSON:\n" + JSON.stringify({ server: d.server, system: d.system, database: d.database, performance: d.performance }, null, 2) },
        ],
      };
    }
  );
}
