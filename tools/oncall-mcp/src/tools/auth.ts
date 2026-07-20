import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { adminApi, publicApi } from "../http-client.js";

export function registerAuthTools(server: McpServer): void {
  // ─── 1. login_user ───────────────────────────────────────────
  server.tool(
    "login_user",
    "Log in a passenger user by phone number. Returns an access token (15 min), a refresh token (30 days), and user details. Creates the user if they don't exist yet. Admin phones receive a 24-hour token with no refresh token.",
    {
      phone: z.string().min(3).describe("Passenger phone number"),
      name: z.string().optional().describe("Display name (used only when creating a new user)"),
    },
    async ({ phone, name }) => {
      const response = await publicApi<{
        success: boolean;
        token?: string;
        refreshToken?: string | null;
        user?: unknown;
      }>("post", "/login", { phone, name });
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 2. login_driver ─────────────────────────────────────────
  server.tool(
    "login_driver",
    "Log in a driver by phone number. Returns an access token (15 min), a refresh token (30 days), and driver profile.",
    {
      phone: z.string().min(3).describe("Driver phone number"),
    },
    async ({ phone }) => {
      const response = await publicApi<{
        success: boolean;
        token?: string;
        refreshToken?: string;
        driver?: unknown;
      }>("post", "/driver/login", { phone });
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 3. logout_user ──────────────────────────────────────────
  server.tool(
    "logout_user",
    "Invalidate the current admin/user access token. Optionally revokes a refresh token too if provided.",
    {
      refreshToken: z
        .string()
        .optional()
        .describe("The refresh token to revoke (optional — revokes only access token if omitted)"),
    },
    async ({ refreshToken }) => {
      const response = await adminApi<{ success: boolean; message?: string }>(
        "post",
        "/logout",
        refreshToken ? { refreshToken } : {}
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 4. verify_session ───────────────────────────────────────
  server.tool(
    "verify_session",
    "Verify the current admin token is valid and return its decoded payload (phone, type, role, exp).",
    {},
    async () => {
      const response = await adminApi<{ success: boolean; session?: unknown }>(
        "get",
        "/auth/verify"
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 5. refresh_session ──────────────────────────────────────
  server.tool(
    "refresh_session",
    "Exchange a valid refresh token for a new access token (15 min) and a new refresh token (30 days). The old refresh token is immediately invalidated (rotation).",
    {
      refreshToken: z
        .string()
        .min(10)
        .describe("The refresh token received from login_user or login_driver"),
    },
    async ({ refreshToken }) => {
      const response = await publicApi<{
        success: boolean;
        token?: string;
        refreshToken?: string;
        message?: string;
      }>("post", "/auth/refresh", { refreshToken });
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 6. logout_all_devices ───────────────────────────────────
  server.tool(
    "logout_all_devices",
    "Revoke ALL active sessions (access + refresh tokens) for the currently authenticated user. Use this when a device is lost or compromised.",
    {},
    async () => {
      const response = await adminApi<{ success: boolean; message?: string }>(
        "post",
        "/auth/logout-all"
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
