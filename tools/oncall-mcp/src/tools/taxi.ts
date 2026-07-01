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
  pickupLat: number | null;
  pickupLng: number | null;
  destLat: number | null;
  destLng: number | null;
  driver_lat: number | null;
  driver_lng: number | null;
  status: string;
  estimatedFare: number;
  finalFare: number | null;
  payment_method: string;
  payment_status: string;
  rating: number | null;
  route: unknown[];
  created_at: string;
}

const CoordinatesSchema = {
  pickupLat: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe("Pickup latitude — enables server-side fare calculation"),
  pickupLng: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe("Pickup longitude"),
  destLat: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe("Destination latitude"),
  destLng: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe("Destination longitude"),
};

export function registerTaxiTools(server: McpServer): void {
  server.tool(
    "create_taxi_request",
    "Create a new taxi trip request for a user. Returns the created trip with its ID and estimated fare. Providing coordinates enables accurate fare calculation.",
    {
      phone: z
        .string()
        .min(3)
        .describe("Phone number of the user requesting the ride"),
      pickup: z
        .string()
        .min(2)
        .describe("Pickup location name or address"),
      destination: z
        .string()
        .min(2)
        .describe("Destination name or address"),
      ...CoordinatesSchema,
    },
    async ({ phone, pickup, destination, pickupLat, pickupLng, destLat, destLng }) => {
      const response = await adminApi<{ success: boolean; trip: Trip; message?: string }>(
        "post",
        "/taxi/request",
        { phone, pickup, destination, pickupLat, pickupLng, destLat, destLng }
      );

      if (!response.success) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to create taxi request: ${response.message ?? "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.trip, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_taxi_request_status",
    "Get the current status and details of a taxi trip by its ID. Status values: waiting_driver, accepted, in_progress, completed, cancelled, no_driver.",
    {
      id: z
        .number()
        .int()
        .positive()
        .describe("The trip's numeric ID returned when the request was created"),
    },
    async ({ id }) => {
      const response = await publicApi<{ success: boolean; trip: Trip }>(
        "get",
        `/taxi/trips/${id}`
      );

      if (!response.success || !response.trip) {
        return {
          content: [
            {
              type: "text",
              text: `No taxi trip found with ID: ${id}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.trip, null, 2),
          },
        ],
      };
    }
  );
}
