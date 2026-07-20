import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { adminApi, publicApi } from "../http-client.js";

interface Trip {
  id: number;
  user_phone: string | null;
  driver_name: string | null;
  driver_id: number | null;
  pickup: string;
  destination: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  dest_lat: number | null;
  dest_lng: number | null;
  driver_lat: number | null;
  driver_lng: number | null;
  status: string;
  estimated_fare: number;
  final_fare: number | null;
  payment_method: string;
  payment_status: string;
  rating: number | null;
  route: unknown[];
  start_time: number | null;
  end_time: string | null;
  total_distance: number;
  duration_minutes: number;
  cancelled_by: string | null;
  cancel_reason: string | null;
  rating_comment: string | null;
  created_at: string;
}

const VALID_STATUSES = [
  "waiting_driver",
  "accepted",
  "arrived",
  "in_progress",
  "completed",
  "cancelled",
  "no_driver",
] as const;

export function registerTripTools(server: McpServer): void {
  // ─── 1. list_trips ───────────────────────────────────────────
  server.tool(
    "list_trips",
    "List all trips with pagination and optional status filter. Returns up to 50 trips per page with pagination info.",
    {
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 50)"),
      status: z
        .enum(VALID_STATUSES)
        .optional()
        .describe("Filter by trip status"),
    },
    async ({ page, limit, status }) => {
      const params = new URLSearchParams();
      if (page) params.set("page", String(page));
      if (limit) params.set("limit", String(limit));
      if (status) params.set("status", status);
      const qs = params.toString();
      const response = await adminApi<{
        trips: Trip[];
        pagination: { page: number; limit: number; total: number; pages: number };
      }>("get", `/admin/trips${qs ? "?" + qs : ""}`);
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 2. get_trip ─────────────────────────────────────────────
  server.tool(
    "get_trip",
    "Get the full details of a single trip by ID, including status, fare, driver info, route, and timestamps.",
    {
      id: z.number().int().positive().describe("The trip's numeric ID"),
    },
    async ({ id }) => {
      const response = await publicApi<{ success: boolean; trip: Trip }>(
        "get",
        `/taxi/trips/${id}`
      );
      if (!response.success || !response.trip) {
        return {
          content: [{ type: "text", text: `No trip found with ID: ${id}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(response.trip, null, 2) }],
      };
    }
  );

  // ─── 3. get_trip_location ────────────────────────────────────
  server.tool(
    "get_trip_location",
    "Get the real-time driver location and live stats (distance, duration, current fare) for an in-progress trip.",
    {
      id: z.number().int().positive().describe("The trip's numeric ID"),
    },
    async ({ id }) => {
      const response = await publicApi<Record<string, unknown>>(
        "get",
        `/taxi/trips/${id}/location`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 4. list_passenger_trips ─────────────────────────────────
  server.tool(
    "list_passenger_trips",
    "List all trips for a specific passenger by their phone number.",
    {
      phone: z.string().min(3).describe("The passenger's phone number"),
    },
    async ({ phone }) => {
      // API returns array directly
      const trips = await adminApi<Trip[]>(
        "get",
        `/taxi/trips/passenger/${encodeURIComponent(phone)}`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(trips, null, 2) }],
      };
    }
  );

  // ─── 5. list_driver_trips ────────────────────────────────────
  server.tool(
    "list_driver_trips",
    "List all trips assigned to a specific driver by their phone number (last 100).",
    {
      phone: z.string().min(3).describe("The driver's phone number"),
    },
    async ({ phone }) => {
      const response = await adminApi<Trip[]>(
        "get",
        `/driver/trips/${encodeURIComponent(phone)}`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 6. update_trip_status ───────────────────────────────────
  server.tool(
    "update_trip_status",
    "Update the status of a trip. Valid transitions: waiting_driver → accepted → arrived → in_progress → completed | cancelled. When accepting, optionally provide driver_phone to assign the driver. Completing a trip auto-calculates the fare.",
    {
      id: z.number().int().positive().describe("The trip's numeric ID"),
      status: z
        .enum(["accepted", "arrived", "in_progress", "completed", "cancelled"])
        .describe("New status to set"),
      driver_phone: z
        .string()
        .optional()
        .describe("Driver's phone number — required when status is 'accepted'"),
    },
    async ({ id, status, driver_phone }) => {
      const body: Record<string, unknown> = { status };
      if (driver_phone) body.driver_phone = driver_phone;
      const response = await adminApi<{ success: boolean; trip: Trip }>(
        "put",
        `/taxi/trips/${id}/status`,
        body
      );
      if (!response.success) {
        return {
          content: [{ type: "text", text: `Failed to update trip ${id} to status '${status}'` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(response.trip, null, 2) }],
      };
    }
  );

  // ─── 7. rate_trip ────────────────────────────────────────────
  server.tool(
    "rate_trip",
    "Rate a completed trip (passenger rating for driver). Rating must be 1–5. Optionally include a text comment.",
    {
      id: z.number().int().positive().describe("The trip's numeric ID"),
      rating: z
        .number()
        .int()
        .min(1)
        .max(5)
        .describe("Star rating from 1 (poor) to 5 (excellent)"),
      comment: z
        .string()
        .optional()
        .describe("Optional written review"),
    },
    async ({ id, rating, comment }) => {
      const response = await adminApi<{ success: boolean; message: string }>(
        "post",
        `/taxi/trips/${id}/rate`,
        { rating, comment }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 8. cancel_trip ──────────────────────────────────────────
  server.tool(
    "cancel_trip",
    "Cancel a trip as admin. Sets status to 'cancelled' and frees the assigned driver. Use this for trip disputes or stuck trips.",
    {
      id: z.number().int().positive().describe("The trip's numeric ID to cancel"),
    },
    async ({ id }) => {
      const response = await adminApi<{ success: boolean }>(
        "put",
        `/admin/trips/${id}/cancel`
      );
      return {
        content: [
          {
            type: "text",
            text: response.success
              ? `Trip #${id} has been cancelled successfully.`
              : `Failed to cancel trip #${id}.`,
          },
        ],
        isError: !response.success,
      };
    }
  );

  // ─── 9. list_waiting_trips ───────────────────────────────────
  server.tool(
    "list_waiting_trips",
    "List all trips currently waiting for a driver (status: waiting_driver), ordered by creation time. Useful for monitoring dispatch queue and detecting stuck trips.",
    {},
    async () => {
      const trips = await publicApi<Trip[]>("get", "/taxi/requests");
      return {
        content: [{ type: "text", text: JSON.stringify(trips, null, 2) }],
      };
    }
  );

  // ─── 10. clear_all_trips ─────────────────────────────────────
  server.tool(
    "clear_all_trips",
    "⚠️ DESTRUCTIVE: Delete ALL trips from the database. Use only in development/testing environments. This action cannot be undone.",
    {},
    async () => {
      const response = await adminApi<{ success: boolean; message?: string }>(
        "delete",
        "/taxi/trips"
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 11. reject_trip ─────────────────────────────────────────
  server.tool(
    "reject_trip",
    "Driver rejects (declines) a trip offer. NOTE: requires a driver JWT token — will fail with admin token (403).",
    {
      id: z.number().int().positive().describe("Trip ID to reject"),
    },
    async ({ id }) => {
      const response = await adminApi<{ success: boolean }>(
        "post",
        `/taxi/trips/${id}/reject`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 12. rate_passenger ──────────────────────────────────────
  server.tool(
    "rate_passenger",
    "Driver rates a passenger after a completed trip (1–5 stars, optional comment). NOTE: requires a driver JWT token — will fail with admin token (403).",
    {
      id: z.number().int().positive().describe("Trip ID"),
      rating: z.number().min(1).max(5).describe("Rating 1-5"),
      comment: z.string().optional().describe("Optional comment"),
    },
    async ({ id, rating, comment }) => {
      const response = await adminApi<{ success: boolean }>(
        "post",
        `/taxi/trips/${id}/rate-passenger`,
        { rating, comment }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 13. update_driver_location ──────────────────────────────
  server.tool(
    "update_driver_location",
    "Update the driver's GPS location for an active trip (HTTP fallback — normally done via Socket.IO). NOTE: requires a driver JWT token — will fail with admin token (403).",
    {
      trip_id: z.number().int().positive().describe("Active trip ID"),
      lat: z.number().describe("Latitude"),
      lng: z.number().describe("Longitude"),
    },
    async ({ trip_id, lat, lng }) => {
      const response = await adminApi<{ success: boolean }>(
        "post",
        "/taxi/update-location",
        { tripId: trip_id, lat, lng }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 14. get_driver_active_trips ─────────────────────────────
  server.tool(
    "get_driver_active_trips",
    "Get the driver's currently active (accepted/in-progress) trips. NOTE: requires a driver JWT token — will fail with admin token (403).",
    {},
    async () => {
      const trips = await adminApi<Trip[]>("get", "/taxi/trips");
      return {
        content: [{ type: "text", text: JSON.stringify(trips, null, 2) }],
      };
    }
  );
}
