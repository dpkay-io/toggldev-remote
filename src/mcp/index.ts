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

const server = new Server(
  {
    name: "toggldev-remote-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
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
      const result = await api.toggleSetting(key, enabled);
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
