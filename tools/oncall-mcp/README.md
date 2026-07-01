# oncall-mcp

MCP server for the OnCall backend. Exposes users, drivers, scooters, and taxi requests as tools that Claude can call directly.

## Project structure

```
src/
├── server.ts          # Entry point — creates McpServer, starts stdio transport
├── config.ts          # Reads and validates env vars at startup
├── http-client.ts     # Axios instance — adminApi and publicApi helpers
└── tools/
    ├── index.ts       # Registers all tools on the server instance
    ├── users.ts       # list_users, get_user_by_phone
    ├── drivers.ts     # list_drivers, get_driver_by_phone
    ├── scooters.ts    # list_scooters, get_scooter_by_id
    └── taxi.ts        # create_taxi_request, get_taxi_request_status
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in this directory (or export in your shell):

```env
ONCALL_BASE_URL=http://localhost:3000
ONCALL_ADMIN_TOKEN=<JWT from your backend admin login>
```

**Getting the admin token** — call your backend's login endpoint with an admin phone number:

```bash
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{"phone": "112"}'
```

Copy the `token` from the response and set it as `ONCALL_ADMIN_TOKEN`.

### 3. Build

```bash
npm run build
```

Compiled output lands in `dist/`.

### 4. Run

```bash
# Production (compiled)
npm start

# Development (live reload, no build step)
npm run dev
```

## Claude Desktop configuration

Add this block to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oncall": {
      "command": "node",
      "args": ["/Users/abood/oncall-backend/tools/oncall-mcp/dist/server.js"],
      "env": {
        "ONCALL_BASE_URL": "http://localhost:3000",
        "ONCALL_ADMIN_TOKEN": "<your-admin-jwt>"
      }
    }
  }
}
```

Restart Claude Desktop after saving. The tools appear automatically.

## Tool reference

### Users

| Tool | Inputs | Description |
|------|--------|-------------|
| `list_users` | `limit?` (number) | List all users, optionally capped |
| `get_user_by_phone` | `phone` (string) | Get a single user by phone number |

### Drivers

| Tool | Inputs | Description |
|------|--------|-------------|
| `list_drivers` | `status?` (online/offline/busy), `limit?` | List drivers, optionally filtered by status |
| `get_driver_by_phone` | `phone` (string) | Get a single driver including car info and rating |

### Scooters

| Tool | Inputs | Description |
|------|--------|-------------|
| `list_scooters` | `status?` (available/in_use/maintenance), `limit?` | List scooters, optionally filtered by status |
| `get_scooter_by_id` | `id` (number) | Get a single scooter by numeric ID |

### Taxi

| Tool | Inputs | Description |
|------|--------|-------------|
| `create_taxi_request` | `phone`, `pickup`, `destination`, `pickupLat?`, `pickupLng?`, `destLat?`, `destLng?` | Create a trip request; coordinates enable fare calculation |
| `get_taxi_request_status` | `id` (number) | Get trip status — waiting_driver / accepted / in_progress / completed / cancelled / no_driver |

## Auth model

- **Admin endpoints** (`/admin/users`, `/admin/drivers`, `/taxi/request`) — use `ONCALL_ADMIN_TOKEN` automatically via `adminApi`
- **Public endpoints** (`/scooters`, `/taxi/trips/:id`) — no token, use `publicApi`
- The admin token also satisfies the regular `authenticate` middleware, so no second token is needed
