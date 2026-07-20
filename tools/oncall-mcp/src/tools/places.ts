import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { adminApi } from "../http-client.js";

export function registerPlacesTools(server: McpServer): void {
  // ─── 1. search_places ────────────────────────────────────────
  server.tool(
    "search_places",
    "Search for places using Google Places Autocomplete. Returns a list of place suggestions based on the input text. Optionally biased by lat/lng.",
    {
      input: z.string().min(1).describe("Search text (e.g. 'Kuwait City', 'Salmiya')"),
      lat: z.number().optional().describe("Latitude to bias results towards"),
      lng: z.number().optional().describe("Longitude to bias results towards"),
    },
    async ({ input, lat, lng }) => {
      const params = new URLSearchParams({ input });
      if (lat !== undefined) params.set("lat", String(lat));
      if (lng !== undefined) params.set("lng", String(lng));
      const response = await adminApi<unknown>(
        "get",
        `/places/autocomplete?${params.toString()}`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 2. get_place_details ─────────────────────────────────────
  server.tool(
    "get_place_details",
    "Get full details (name, address, lat/lng) for a place using its Google Place ID (obtained from search_places).",
    {
      place_id: z.string().min(1).describe("Google Place ID from search_places result"),
    },
    async ({ place_id }) => {
      const response = await adminApi<unknown>(
        "get",
        `/places/details?place_id=${encodeURIComponent(place_id)}`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
