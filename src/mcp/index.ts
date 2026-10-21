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
import { connectAdb, disconnectAdb } from "../core/adb.js";
import { parseBoolean, packageVersion, KNOWN_TOGGLE_KEYS, KNOWN_SET_KEYS } from "../core/util.js";

const server = new Server(
  {
    name: "toggldev-remote-mcp",
    version: packageVersion(),
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: `You have access to toggldev-remote, which controls Android Developer Options and wireless ADB over the network via the TogglDev companion app.

USE THIS WHEN:
- You need to connect to an Android device (e.g. for ADB, app deployment, tests) and no device is connected.
- You need to change a Developer Options setting (wireless debugging, animation scales, stay awake, etc.) on an Android device.

WORKFLOW:
1. Call list_devices (check: true) to see the paired phones and which are reachable. Pass the phone's name as "device" to every other tool; with several phones paired, leaving it out can act on the wrong one.
2. To run adb commands, call connect_adb and then use the serial it returns: adb -s <serial> ... It turns wireless debugging on if needed, picks the right port and confirms adb can talk to the phone. The port changes whenever adb restarts on the phone, so call connect_adb again instead of reusing an old serial. Do not build the address from get_wireless_debug_info: the app can report another phone's port.
3. When finished, or if the user asks, call disconnect_adb to turn wireless debugging off.
4. toggle_setting and set_setting check the phone's status afterwards and fail if the change did not take. verified: true means confirmed; verified: null means the phone does not report that setting, so it is unconfirmed.
5. A phone that is not paired: call discover_devices (mDNS, same network only), then pair_device with its host, a name for it, and the 6-digit code from the TogglDev app. Ask the user for the code.

IMPORTANT:
- Pairing is persistent. Only ask for a code when pair_device is needed.
- A phone keeps ONE pairing token. If another computer paired with it since, you get "Authentication failed": pair again, and tell the user that the other computer's pairing stopped working.
- Pairing is rate-limited (a few wrong codes, then a lockout of about five minutes). Never guess codes.
- Discovery uses mDNS and only works on the local network (not over Tailscale/VPN); for remote phones pair using the direct or Tailscale IP.`,
  }
);

const deviceProperty = {
  device: {
    type: "string",
    description: "Name of the paired phone (see list_devices). Omit only when a single phone is paired."
  }
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_devices",
        description: "List the paired phones (names and addresses, never tokens). With check, also report which are reachable now.",
        inputSchema: {
          type: "object",
          properties: {
            check: {
              type: "boolean",
              description: "Also ask each phone for its status to see whether it is reachable (default: false)"
            }
          }
        }
      },
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
        description: "Pair with a TogglDev device using the code from the app. Give it a name to keep several phones.",
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
            },
            device: {
              type: "string",
              description: "Name to save this phone under, e.g. \"pixel\" (letters, digits, dot, dash, underscore)"
            }
          },
          required: ["host", "code"]
        }
      },
      {
        name: "get_status",
        description: "Get the current developer settings status from the paired device.",
        inputSchema: {
          type: "object",
          properties: { ...deviceProperty }
        }
      },
      {
        name: "toggle_setting",
        description: "Switch a boolean developer setting on or off, then confirm through the phone's status that it took effect (fails if it did not).",
        inputSchema: {
          type: "object",
          properties: {
            ...deviceProperty,
            key: {
              type: "string",
              description: `The setting key. Known keys: ${KNOWN_TOGGLE_KEYS.join(", ")}. The phone rejects unknown keys.`
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
        description: "Set a value for a developer setting, then confirm it through the phone's status where the phone reports it.",
        inputSchema: {
          type: "object",
          properties: {
            ...deviceProperty,
            key: {
              type: "string",
              description: `The setting key. Known keys: ${KNOWN_SET_KEYS.join(", ")}. The phone rejects unknown keys.`
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
        name: "connect_adb",
        description: "Turn on wireless debugging if needed and 'adb connect' to the phone. Returns the serial to use as 'adb -s <serial>'. Call again if the connection drops: the port changes when adb restarts.",
        inputSchema: {
          type: "object",
          properties: { ...deviceProperty }
        }
      },
      {
        name: "disconnect_adb",
        description: "Disconnect adb from the phone and turn wireless debugging off.",
        inputSchema: {
          type: "object",
          properties: { ...deviceProperty }
        }
      },
      {
        name: "get_wireless_debug_info",
        description: "Raw wireless debugging IP and port as the app reports them. The port can be stale or belong to another phone; use connect_adb to actually connect.",
        inputSchema: {
          type: "object",
          properties: { ...deviceProperty }
        }
      }
    ]
  };
});

const text = (value: unknown) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }]
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = (request.params.arguments ?? {}) as Record<string, any>;
    const device: string | undefined = args.device || undefined;

    switch (request.params.name) {
      case "list_devices":
        return text({ devices: await api.listDevices(args.check === true) });
      case "discover_devices":
        return text({ devices: await api.discoverDevices(args.timeoutSeconds || 5) });
      case "pair_device":
        return text(await api.pairDevice(args.host, args.port || 8734, args.code, device));
      case "get_status":
        return text(await api.getStatus(device));
      case "toggle_setting":
        return text(await api.toggleSetting(args.key, parseBoolean(args.enabled), device));
      case "set_setting":
        return text(await api.setSetting(args.key, args.value, device));
      case "connect_adb":
        return text(await connectAdb(device));
      case "disconnect_adb":
        return text(await disconnectAdb(device));
      case "get_wireless_debug_info":
        return text(await api.getWirelessDebugInfo(device));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
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
