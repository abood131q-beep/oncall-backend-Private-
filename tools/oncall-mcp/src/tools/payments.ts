import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { adminApi, publicApi } from "../http-client.js";

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

export function registerPaymentTools(server: McpServer): void {
  // ─── 1. get_payment_methods ──────────────────────────────────
  server.tool(
    "get_payment_methods",
    "Get all available payment methods (cash, wallet, knet, visa, apple_pay) and their availability status.",
    {},
    async () => {
      const response = await publicApi<{ success: boolean; methods: unknown[] }>(
        "get",
        "/payment/methods"
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response.methods, null, 2) }],
      };
    }
  );

  // ─── 2. get_wallet_transactions ──────────────────────────────
  server.tool(
    "get_wallet_transactions",
    "Get wallet transaction history for a user: balance, deposits, trip payments, charges. Returns last 50 transactions.",
    {
      phone: z.string().min(3).describe("The user's phone number"),
    },
    async ({ phone }) => {
      const response = await adminApi<{
        success: boolean;
        balance: number;
        transactions: Transaction[];
      }>("get", `/wallet/transactions/${encodeURIComponent(phone)}`);
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 3. charge_wallet ────────────────────────────────────────
  server.tool(
    "charge_wallet",
    "Add funds to a user's wallet. The admin token is used as the authenticated user, so this adds balance to the admin's own wallet (useful for testing). For adding balance to a specific user, use the balance/add endpoint via custom integration.",
    {
      amount: z
        .number()
        .positive()
        .describe("Amount in KD to add (e.g. 5.0 = 5 KD)"),
      method: z
        .string()
        .optional()
        .describe("Payment method used (for record-keeping only, e.g. 'knet', 'cash')"),
    },
    async ({ amount, method }) => {
      const response = await adminApi<{ success: boolean; balance: number; message?: string }>(
        "post",
        "/wallet/charge",
        { amount, method }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 4. estimate_fare ────────────────────────────────────────
  server.tool(
    "estimate_fare",
    "Calculate the estimated fare for a trip given pickup and destination coordinates. Returns distance in km, estimated minutes, fare breakdown (base + per-km + per-minute + surge multiplier), and current pricing config.",
    {
      pickupLat: z
        .number()
        .min(-90)
        .max(90)
        .describe("Pickup latitude"),
      pickupLng: z
        .number()
        .min(-180)
        .max(180)
        .describe("Pickup longitude"),
      destLat: z
        .number()
        .min(-90)
        .max(90)
        .describe("Destination latitude"),
      destLng: z
        .number()
        .min(-180)
        .max(180)
        .describe("Destination longitude"),
    },
    async ({ pickupLat, pickupLng, destLat, destLng }) => {
      const response = await publicApi<Record<string, unknown>>(
        "post",
        "/fare/estimate",
        { pickupLat, pickupLng, destLat, destLng }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ─── 5. get_fare_config ──────────────────────────────────────
  server.tool(
    "get_fare_config",
    "Get the current pricing configuration: base fare, per-km rate, per-minute rate, minimum fare, surge multiplier, and pricing type (normal/peak/night).",
    {},
    async () => {
      const response = await publicApi<Record<string, unknown>>("get", "/fare/config");
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
