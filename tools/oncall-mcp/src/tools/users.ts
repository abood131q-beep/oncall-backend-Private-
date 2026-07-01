import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { adminApi } from "../http-client.js";

interface User {
  id: number;
  phone: string;
  name: string;
  balance: number;
  total_trips: number;
  total_spent: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface Notification {
  id: number;
  phone: string;
  title: string;
  body: string;
  type: string;
  is_read: number;
  trip_id: number | null;
  created_at: string;
}

interface Transaction {
  id: number;
  phone: string;
  type: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  description: string;
  trip_id: number | null;
  status: string;
  created_at: string;
}

export function registerUserTools(server: McpServer): void {
  // ─── 1. list_users ───────────────────────────────────────────
  server.tool(
    "list_users",
    "List all registered users in the OnCall system. Returns id, phone, name, balance, total trips, and total spent.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of users to return (default: all)"),
      active_only: z
        .boolean()
        .optional()
        .describe("If true, return only active (non-blocked) users"),
    },
    async ({ limit, active_only }) => {
      const users = await adminApi<User[]>("get", "/admin/users");
      let result = active_only ? users.filter((u) => u.is_active !== 0) : users;
      if (limit) result = result.slice(0, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── 2. get_user_by_phone ────────────────────────────────────
  server.tool(
    "get_user_by_phone",
    "Get a single user's full details by their phone number, including balance and trip history.",
    {
      phone: z
        .string()
        .min(3)
        .describe("The user's phone number as stored in the system"),
    },
    async ({ phone }) => {
      const users = await adminApi<User[]>("get", "/admin/users");
      const user = users.find((u) => u.phone === phone);
      if (!user) {
        return {
          content: [{ type: "text", text: `No user found with phone: ${phone}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(user, null, 2) }],
      };
    }
  );

  // ─── 3. get_user_notifications ───────────────────────────────
  server.tool(
    "get_user_notifications",
    "Get the most recent notifications (up to 20) for a specific user by phone number.",
    {
      phone: z
        .string()
        .min(3)
        .describe("The user's or driver's phone number"),
    },
    async ({ phone }) => {
      const notifications = await adminApi<Notification[]>(
        "get",
        `/notifications/${encodeURIComponent(phone)}`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(notifications, null, 2) }],
      };
    }
  );

  // ─── 4. mark_notifications_read ──────────────────────────────
  server.tool(
    "mark_notifications_read",
    "Mark all notifications as read for a specific user.",
    {
      phone: z
        .string()
        .min(3)
        .describe("The user's phone number"),
    },
    async ({ phone }) => {
      const response = await adminApi<{ success: boolean }>(
        "put",
        `/notifications/${encodeURIComponent(phone)}/read`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 5. get_user_transactions ────────────────────────────────
  server.tool(
    "get_user_transactions",
    "Get the financial transaction history for a user (up to 50 records). Includes deposits, trip payments, and charges.",
    {
      phone: z
        .string()
        .min(3)
        .describe("The user's phone number"),
    },
    async ({ phone }) => {
      const transactions = await adminApi<Transaction[]>(
        "get",
        `/transactions/${encodeURIComponent(phone)}`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(transactions, null, 2) }],
      };
    }
  );

  // ─── 6. submit_report ────────────────────────────────────────
  server.tool(
    "submit_report",
    "Submit a report or complaint on behalf of a user (e.g., driver behaviour, scooter damage). Type can be 'general', 'driver', 'scooter', or 'trip'.",
    {
      phone: z.string().min(3).describe("Phone of the user submitting the report"),
      type: z
        .enum(["general", "driver", "scooter", "trip"])
        .optional()
        .describe("Category of the report (default: general)"),
      description: z.string().min(5).describe("Detailed description of the issue"),
      trip_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Related trip ID if applicable"),
    },
    async ({ phone, type, description, trip_id }) => {
      const response = await adminApi<{ success: boolean; message: string }>(
        "post",
        "/report",
        { phone, type: type ?? "general", description, trip_id }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
