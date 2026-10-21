#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { api } from "../core/api.js";
import { parseBoolean, packageVersion } from "../core/util.js";

const server = new Server(
  {
    name: "toggldev-remote-mcp",
    version: packageVersion(),
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: `You have access to toggldev-remote, which controls Android Developer Options over the network via the TogglDev companion app.

USE THIS WHEN:
- You need to connect to an Android device (e.g. for ADB, wireless debugging, app deployment) but no device is connected — call discover_devices to find one on the network.
- You need to toggle Developer Options settings (wireless debugging, show touches, animation scales, etc.) on an Android device.
- You need wireless ADB connection info to connect to a device.
- Any task involving Android development where a device setting needs to change or a device needs to be reached.

WORKFLOW:
1. When a task requires an Android device, first check if one is already connected (e.g. via adb devices).
2. If no device is found, call discover_devices to find TogglDev-enabled devices on the local network.
3. If a device is found but not yet paired, call pair_device with the device's host and port. Ask the user for the 6-digit pairing code shown in the TogglDev app on their phone.
4. Once paired, use get_status, toggle_setting, set_setting, or get_wireless_debug_info as needed.
5. To enable wireless ADB: call toggle_setting with key "adb_wifi_enabled" and enabled true, then call get_wireless_debug_info to get the IP:port for "adb connect".

IMPORTANT:
- Pairing is persistent — once paired, the device stays paired across sessions. Only ask for a pairing code if pair_device is needed.
- If an API call returns a 401 error, the pairing token has expired. Re-pair by asking the user for a new code.
- Discovery uses mDNS and only works on the local network (not over Tailscale/VPN — use direct IP for remote devices).`,
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "discover_devices",
        description: "Discover TogglDev devices on the local network.",
        inputSchema: {
          type: "object",
          properties: {
            timeoutSeconds: {
              type: "number",
              description: "Timeout for discovery in seconds (default: 5)"
            }
          }
        }
      },
      {
        name: "pair_device",
        description: "Pair with a TogglDev device using the code from the app.",
        inputSchema: {
          type: "object",
          properties: {
            host: {
              type: "string",
              description: "The IP address of the device"
            },
            port: {
              type: "number",
              description: "The port of the device (default: 8734)"
            },
            code: {
              type: "string",
              description: "The pairing code displayed on the app"
            }
          },
          required: ["host", "port", "code"]
        }
      },
      {
        name: "get_status",
        description: "Get the current developer settings status from the paired device.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "toggle_setting",
        description: "Toggle a developer setting on the paired device.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The setting key to toggle (e.g. adb_wifi_enabled, show_touches)"
            },
            enabled: {
              type: "boolean",
              description: "Whether the setting should be enabled or disabled"
            }
          },
          required: ["key", "enabled"]
        }
      },
      {
        name: "set_setting",
        description: "Set a specific value for a developer setting on the paired device.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The setting key to set (e.g. window_animation_scale)"
            },
            value: {
              type: "string",
              description: "The value to set it to (as a string, e.g. '0.5')"
            }
          },
          required: ["key", "value"]
        }
      },
      {
        name: "get_wireless_debug_info",
        description: "Get wireless debugging connection info (IP and Port) from the paired device.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (request.params.name === "discover_devices") {
      const timeoutSeconds = (request.params.arguments?.timeoutSeconds as number) || 5;
      const devices = await api.discoverDevices(timeoutSeconds);
      return { content: [{ type: "text", text: JSON.stringify({ devices }, null, 2) }] };
    }

    if (request.params.name === "pair_device") {
      const { host, port, code } = request.params.arguments as { host: string; port: number; code: string };
      const msg = await api.pairDevice(host, port, code);
      return { content: [{ type: "text", text: msg }] };
    }

    if (request.params.name === "get_status") {
      const status = await api.getStatus();
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    }

    if (request.params.name === "toggle_setting") {
      const { key, enabled } = request.params.arguments as { key: string; enabled: boolean };
      const result = await api.toggleSetting(key, parseBoolean(enabled));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (request.params.name === "set_setting") {
      const { key, value } = request.params.arguments as { key: string; value: string };
      const result = await api.setSetting(key, value);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (request.params.name === "get_wireless_debug_info") {
      const info = await api.getWirelessDebugInfo();
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }

    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
  } catch (error: any) {
    if (error instanceof McpError) throw error;
    return {
      isError: true,
      content: [{ type: "text", text: error.message }]
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("TogglDev Remote MCP server running on stdio");
}

run().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
