import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { adminApi, publicApi } from "../http-client.js";

interface Scooter {
  id: number;
  name: string;
  scooter_code: string | null;
  lat: number;
  lng: number;
  battery: number;
  status: "available" | "in_use" | "maintenance";
  current_user_phone: string | null;
  total_rentals: number;
  created_at: string;
}

interface ScooterRide {
  id: number;
  scooter_id: number;
  user_phone: string;
  start_time: number | null;
  end_time: number | null;
  duration_minutes: number;
  fare: number;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  status: string;
  created_at: string;
}

export function registerScooterTools(server: McpServer): void {
  // ─── 1. list_scooters ────────────────────────────────────────
  server.tool(
    "list_scooters",
    "List all scooters in the OnCall system with their battery level, status, and location. Optionally filter by status.",
    {
      status: z
        .enum(["available", "in_use", "maintenance"])
        .optional()
        .describe("Filter scooters by status"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of scooters to return (default: all)"),
    },
    async ({ status, limit }) => {
      const scooters = await publicApi<Scooter[]>("get", "/scooters");
      let result = status ? scooters.filter((s) => s.status === status) : scooters;
      if (limit) result = result.slice(0, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── 2. get_scooter_by_id ────────────────────────────────────
  server.tool(
    "get_scooter_by_id",
    "Get a single scooter's details by its numeric ID, including battery, location, and current rental status.",
    {
      id: z.number().int().positive().describe("The scooter's numeric ID"),
    },
    async ({ id }) => {
      const scooter = await publicApi<Scooter | { success: false }>(
        "get",
        `/scooters/${id}`
      );
      if ("success" in scooter && scooter.success === false) {
        return {
          content: [{ type: "text", text: `No scooter found with ID: ${id}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(scooter, null, 2) }],
      };
    }
  );

  // ─── 3. get_scooter_ride_history ─────────────────────────────
  server.tool(
    "get_scooter_ride_history",
    "Get the scooter ride history for a specific user. Returns past rides with duration, fare, start/end locations.",
    {
      phone: z.string().min(3).describe("The user's phone number"),
    },
    async ({ phone }) => {
      // API returns array directly
      const rides = await adminApi<ScooterRide[]>(
        "get",
        `/scooter/history/${encodeURIComponent(phone)}`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(rides, null, 2) }],
      };
    }
  );

  // ─── 4. get_active_scooter_ride ──────────────────────────────
  server.tool(
    "get_active_scooter_ride",
    "Check if a user currently has an active scooter ride and get its details (scooter ID, start time, elapsed duration).",
    {
      phone: z.string().min(3).describe("The user's phone number"),
    },
    async ({ phone }) => {
      const response = await adminApi<{ success: boolean; ride?: ScooterRide; active: boolean }>(
        "get",
        `/scooter/active/${encodeURIComponent(phone)}`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 5. add_scooter ──────────────────────────────────────────
  server.tool(
    "add_scooter",
    "Add a new scooter to the fleet. Returns the new scooter's ID.",
    {
      name: z.string().min(2).describe("Scooter display name (e.g. 'Scooter 004')"),
      scooter_code: z
        .string()
        .optional()
        .describe("Unique scooter code (e.g. 'SC004'). Auto-generated if omitted."),
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
      battery: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe("Battery percentage 0–100 (default: 100)"),
    },
    async ({ name, scooter_code, lat, lng, battery }) => {
      const response = await adminApi<{ success: boolean; id: number }>(
        "post",
        "/admin/scooters",
        { name, scooter_code, lat, lng, battery }
      );
      return {
        content: [
          {
            type: "text",
            text: response.success
              ? `Scooter '${name}' added successfully with ID: ${response.id}`
              : "Failed to add scooter.",
          },
        ],
        isError: !response.success,
      };
    }
  );

  // ─── 6. delete_scooter ───────────────────────────────────────
  server.tool(
    "delete_scooter",
    "⚠️ Permanently delete a scooter from the fleet by its ID. Only use when decommissioning hardware. This action cannot be undone.",
    {
      id: z.number().int().positive().describe("The scooter's numeric ID to delete"),
    },
    async ({ id }) => {
      const response = await adminApi<{ success: boolean }>(
        "delete",
        `/admin/scooters/${id}`
      );
      return {
        content: [
          {
            type: "text",
            text: response.success
              ? `Scooter #${id} deleted successfully.`
              : `Failed to delete scooter #${id}.`,
          },
        ],
        isError: !response.success,
      };
    }
  );

  // ─── 7. reset_all_scooters ───────────────────────────────────
  server.tool(
    "end_scooter_ride",
    "End an active scooter ride and calculate the fare. Provide the scooter ID and optional GPS location where the ride ended.",
    {
      scooter_id: z.number().int().positive().describe("ID of the scooter to return"),
      end_lat: z.number().optional().describe("Latitude of drop-off location"),
      end_lng: z.number().optional().describe("Longitude of drop-off location"),
    },
    async ({ scooter_id, end_lat, end_lng }) => {
      const response = await adminApi<{ success: boolean; message?: string; fare?: number }>(
        "post",
        "/scooter/end-ride",
        { scooterId: scooter_id, endLat: end_lat, endLng: end_lng }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  server.tool(
    "unlock_scooter",
    "Unlock a scooter and start a ride for a user. Requires scooter to be available, user to have sufficient balance (≥ 0.500 KD), and battery ≥ 10%.",
    {
      scooter_id: z.number().int().positive().describe("ID of the scooter to unlock"),
    },
    async ({ scooter_id }) => {
      const response = await adminApi<{ success: boolean; message?: string; ride?: unknown }>(
        "post",
        "/scooter/unlock",
        { scooterId: scooter_id }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  server.tool(
    "reset_all_scooters",
    "Reset ALL scooters to 'available' status and clear current users. Use when scooters are stuck in 'in_use' state due to app crashes.",
    {},
    async () => {
      const response = await adminApi<{ success: boolean; message?: string }>(
        "post",
        "/scooters/reset"
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
