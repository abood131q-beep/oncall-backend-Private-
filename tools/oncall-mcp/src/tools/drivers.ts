import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { adminApi } from "../http-client.js";

interface Driver {
  id: number;
  phone: string;
  name: string;
  car_name: string;
  car_model: string;
  car_year: number;
  plate: string;
  color: string;
  rating: number;
  total_ratings: number;
  status: "online" | "offline" | "busy";
  lat: number;
  lng: number;
  total_trips: number;
  total_earnings: number;
  acceptance_rate: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface Review {
  rating: number;
  rating_comment: string | null;
  user_phone: string;
  created_at: string;
}

export function registerDriverTools(server: McpServer): void {
  // ─── 1. list_drivers ─────────────────────────────────────────
  server.tool(
    "list_drivers",
    "List all drivers in the OnCall system. Optionally filter by status (online/offline/busy).",
    {
      status: z
        .enum(["online", "offline", "busy"])
        .optional()
        .describe("Filter drivers by their current status"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of drivers to return (default: all)"),
      active_only: z
        .boolean()
        .optional()
        .describe("If true, return only non-blocked drivers"),
    },
    async ({ status, limit, active_only }) => {
      const drivers = await adminApi<Driver[]>("get", "/admin/drivers");
      let result = drivers;
      if (status) result = result.filter((d) => d.status === status);
      if (active_only) result = result.filter((d) => d.is_active !== 0);
      if (limit) result = result.slice(0, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── 2. get_driver_by_phone ──────────────────────────────────
  server.tool(
    "get_driver_by_phone",
    "Get a single driver's full details by their phone number, including car info, rating, status, and earnings.",
    {
      phone: z
        .string()
        .min(3)
        .describe("The driver's phone number as stored in the system"),
    },
    async ({ phone }) => {
      const response = await adminApi<{ success: boolean; driver: Driver }>(
        "get",
        `/admin/drivers/${encodeURIComponent(phone)}`
      );
      if (!response.success || !response.driver) {
        return {
          content: [{ type: "text", text: `No driver found with phone: ${phone}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(response.driver, null, 2) }],
      };
    }
  );

  // ─── 3. get_driver_stats ─────────────────────────────────────
  server.tool(
    "get_driver_stats",
    "Get detailed performance statistics for a driver: total/completed/cancelled trips, earnings (today, week, total), hours worked, acceptance rate, and average rating.",
    {
      phone: z.string().min(3).describe("The driver's phone number"),
    },
    async ({ phone }) => {
      const response = await adminApi<{ success: boolean; stats: Record<string, unknown> }>(
        "get",
        `/driver/stats/${encodeURIComponent(phone)}`
      );
      if (!response.success) {
        return {
          content: [{ type: "text", text: `No driver found with phone: ${phone}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(response.stats, null, 2) }],
      };
    }
  );

  // ─── 4. get_driver_reviews ───────────────────────────────────
  server.tool(
    "get_driver_reviews",
    "Get the most recent passenger reviews and ratings for a driver (up to 20 reviews). Returns average rating and each review's score, comment, and reviewer's phone.",
    {
      phone: z.string().min(3).describe("The driver's phone number"),
    },
    async ({ phone }) => {
      const response = await adminApi<{
        success: boolean;
        avgRating: number;
        totalRatings: number;
        reviews: Review[];
      }>("get", `/driver/reviews/${encodeURIComponent(phone)}`);
      if (!response.success) {
        return {
          content: [{ type: "text", text: `No driver found with phone: ${phone}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 5. update_driver ────────────────────────────────────────
  server.tool(
    "update_driver",
    "Update a driver's name, car name, or license plate. All fields are optional — only provided fields are changed.",
    {
      phone: z.string().min(3).describe("The driver's phone number"),
      name: z.string().min(2).optional().describe("New display name for the driver"),
      car_name: z.string().optional().describe("Vehicle make/model (e.g. 'Toyota Camry')"),
      plate: z.string().optional().describe("License plate number"),
    },
    async ({ phone, name, car_name, plate }) => {
      // Fetch current values so we send complete data
      const infoRes = await adminApi<{ success: boolean; driver: Driver }>(
        "get",
        `/admin/drivers/${encodeURIComponent(phone)}`
      );
      if (!infoRes.success || !infoRes.driver) {
        return {
          content: [{ type: "text", text: `No driver found with phone: ${phone}` }],
          isError: true,
        };
      }
      const d = infoRes.driver;
      const response = await adminApi<{ success: boolean; driver: Driver }>(
        "post",
        "/driver/update",
        {
          phone,
          name: name ?? d.name,
          car_name: car_name ?? d.car_name,
          plate: plate ?? d.plate,
        }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response.driver ?? response, null, 2) }],
      };
    }
  );

  // ─── 6. set_driver_status ────────────────────────────────────
  server.tool(
    "set_driver_status",
    "Set a driver online or offline. NOTE: requires a driver JWT token — will fail with admin token (403). Use for testing or when a driver token is available.",
    {
      is_online: z.boolean().describe("true = online (accepting trips), false = offline"),
    },
    async ({ is_online }) => {
      const response = await adminApi<{ success: boolean }>(
        "post",
        "/driver/status",
        { isOnline: is_online }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // P6-06: Driver Approval Workflow Tools
  // ═══════════════════════════════════════════════════════════════

  // ─── 7. list_pending_drivers ─────────────────────────────────
  server.tool(
    "list_pending_drivers",
    "List all drivers waiting for admin approval (approval_status = 'pending'). Returns phone, name, car info, and registration date for each pending driver.",
    {},
    async () => {
      const response = await adminApi<{
        success: boolean;
        count: number;
        drivers: Driver[];
      }>("get", "/admin/drivers/pending");
      return {
        content: [
          {
            type: "text",
            text: response.count === 0
              ? "No drivers pending approval."
              : JSON.stringify(response, null, 2),
          },
        ],
      };
    }
  );

  // ─── 8. approve_driver ───────────────────────────────────────
  server.tool(
    "approve_driver",
    "Approve a pending driver, allowing them to log in and accept trips. The action is logged with the admin's phone and timestamp.",
    {
      phone: z
        .string()
        .min(3)
        .describe("The driver's phone number to approve"),
    },
    async ({ phone }) => {
      const response = await adminApi<{ success: boolean; driver: Driver }>(
        "put",
        `/admin/drivers/${encodeURIComponent(phone)}/approve`,
        {}
      );
      if (!response.success) {
        return {
          content: [{ type: "text", text: `Failed to approve driver: ${phone}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `✅ Driver approved: ${phone}\n\n${JSON.stringify(response.driver, null, 2)}`,
          },
        ],
      };
    }
  );

  // ─── 9. reject_driver ────────────────────────────────────────
  server.tool(
    "reject_driver",
    "Reject a driver's registration with a mandatory reason. The driver will see the reason when they attempt to log in.",
    {
      phone: z
        .string()
        .min(3)
        .describe("The driver's phone number to reject"),
      reason: z
        .string()
        .min(5)
        .max(500)
        .describe("Clear reason for rejection (shown to the driver)"),
    },
    async ({ phone, reason }) => {
      const response = await adminApi<{ success: boolean; driver: Driver }>(
        "put",
        `/admin/drivers/${encodeURIComponent(phone)}/reject`,
        { reason }
      );
      if (!response.success) {
        return {
          content: [{ type: "text", text: `Failed to reject driver: ${phone}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `❌ Driver rejected: ${phone}\nReason: ${reason}\n\n${JSON.stringify(response.driver, null, 2)}`,
          },
        ],
      };
    }
  );

  // ─── 10. suspend_driver ──────────────────────────────────────
  server.tool(
    "suspend_driver",
    "Suspend an approved driver with a mandatory reason. Immediately revokes their JWT, forces Socket.IO disconnect, and blocks new logins. The driver sees the reason.",
    {
      phone: z
        .string()
        .min(3)
        .describe("The driver's phone number to suspend"),
      reason: z
        .string()
        .min(5)
        .max(500)
        .describe("Clear reason for suspension (shown to the driver)"),
    },
    async ({ phone, reason }) => {
      const response = await adminApi<{ success: boolean; driver: Driver }>(
        "put",
        `/admin/drivers/${encodeURIComponent(phone)}/suspend`,
        { reason }
      );
      if (!response.success) {
        return {
          content: [{ type: "text", text: `Failed to suspend driver: ${phone}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `⛔ Driver suspended: ${phone}\nReason: ${reason}\nJWT revoked + Socket disconnected.\n\n${JSON.stringify(response.driver, null, 2)}`,
          },
        ],
      };
    }
  );

  // ─── 11. reactivate_driver ───────────────────────────────────
  server.tool(
    "reactivate_driver",
    "Reactivate a previously rejected or suspended driver, restoring full access. Cannot be used on pending drivers (use approve_driver instead).",
    {
      phone: z
        .string()
        .min(3)
        .describe("The driver's phone number to reactivate"),
    },
    async ({ phone }) => {
      const response = await adminApi<{ success: boolean; driver: Driver }>(
        "put",
        `/admin/drivers/${encodeURIComponent(phone)}/reactivate`,
        {}
      );
      if (!response.success) {
        return {
          content: [{ type: "text", text: `Failed to reactivate driver: ${phone}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `✅ Driver reactivated: ${phone}\n\n${JSON.stringify(response.driver, null, 2)}`,
          },
        ],
      };
    }
  );
}
