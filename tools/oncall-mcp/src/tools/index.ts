import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerUserTools } from "./users.js";
import { registerDriverTools } from "./drivers.js";
import { registerScooterTools } from "./scooters.js";
import { registerTaxiTools } from "./taxi.js";
import { registerTripTools } from "./trips.js";
import { registerAdminTools } from "./admin.js";
import { registerPaymentTools } from "./payments.js";
import { registerEngineeringTools } from "./engineering.js";
import { registerPlacesTools } from "./places.js";
import { registerAuthTools } from "./auth.js";

export function registerAllTools(server: McpServer): void {
  registerUserTools(server);
  registerDriverTools(server);
  registerScooterTools(server);
  registerTaxiTools(server);
  registerTripTools(server);
  registerAdminTools(server);
  registerPaymentTools(server);
  registerEngineeringTools(server);
  registerPlacesTools(server);
  registerAuthTools(server);
}
