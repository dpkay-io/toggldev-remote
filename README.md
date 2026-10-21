[![Claude Code](https://img.shields.io/badge/Claude_Code-cc785c)](https://github.com/dpkay-io/toggldev-remote) [![Cursor](https://img.shields.io/badge/Cursor-000000)](https://github.com/dpkay-io/toggldev-remote) [![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-4285F4)](https://github.com/dpkay-io/toggldev-remote) [![Platform](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-blue)](https://github.com/dpkay-io/toggldev-remote) [![License](https://img.shields.io/npm/l/toggldev-remote)](https://github.com/dpkay-io/toggldev-remote) [![productivity](https://img.shields.io/badge/productivity-blue)](https://github.com/dpkay-io/toggldev-remote) [![ai-tools](https://img.shields.io/badge/ai--tools-blueviolet)](https://github.com/dpkay-io/toggldev-remote) [![npm downloads](https://img.shields.io/npm/dt/toggldev-remote)](https://www.npmjs.com/package/toggldev-remote) [![npm version](https://img.shields.io/npm/v/toggldev-remote)](https://www.npmjs.com/package/toggldev-remote) [![Node version](https://img.shields.io/node/v/toggldev-remote)](https://nodejs.org)

# toggldev-remote

**Control your Android Developer Options from the terminal — or let your AI agent do it.**

CLI and MCP server that discovers, pairs with, and controls the Developer options on Android device over your local network. No USB cable, no manual tapping through menus.

📱 **Companion TogglDev app:** Available on [Google Play](https://play.google.com/store/apps/details?id=com.dpkay.apps.developer_options_toggler) and [Github](https://github.com/dpkay-io/toggldev)

## Install

```bash
npm install -g toggldev-remote
```

This installs two commands:

| Command | Purpose |
|---------|---------|
| **`toggldev`** | CLI for direct terminal use |
| **`toggldev-mcp`** | MCP server for AI clients |

---

## The Problem

You're deep in a coding session. You need wireless debugging enabled on your phone, or you need to change animation scales for testing. So you pick up the phone, unlock it, navigate to Developer Options, toggle the setting, then get back to your terminal.

With an AI agent, it's worse — the agent can build your app, but it can't reach over and flip a switch on your phone.

## The Fix

**Via Terminal:**
```bash
toggldev toggle --key adb_wifi_enabled --enabled true
```

**Via AI Agent (MCP):**
> *"Enable wireless debugging"*

One command, or one prompt to your AI — no human in the loop.

---

## Features

- **Auto-discovery** — Finds devices running TogglDev on the local network via mDNS. No IP addresses to remember.
- **Secure pairing** — Connects using the 6-digit pairing code from the TogglDev app. Credentials are saved for future sessions.
- **Full control** — Toggle developer settings, set animation scales, get device status, retrieve wireless debugging connection info.
- **MCP server** — Works as a tool provider for Claude, Cursor, Gemini, and any MCP-compatible AI agent.
- **Remote access** — Pair over Tailscale to control your device from any network.

---

## Prerequisites

- **Node.js** (v18+)
- **[TogglDev Android App](https://github.com/dpkay-io/toggldev) v2.0+** — available on [Google Play](https://play.google.com/store/apps/details?id=com.dpkay.apps.developer_options_toggler) or [GitHub Releases](https://github.com/dpkay-io/toggldev/releases/latest)
- Your computer and Android device on the **same local network** (or connected via Tailscale)

---

## Quick Start

```bash
# 1. Find your phone on the network
toggldev discover

# 2. Open the TogglDev app, note the 6-digit code, then pair
toggldev pair --host 192.168.1.100 --port 8734 --code 123456

# 3. Turn on wireless debugging and connect ADB (prints the serial to use)
toggldev connect-adb

# 4. Use it
adb -s <serial> devices
```

---

## CLI Reference

### Discover devices

```bash
toggldev discover
toggldev discover --timeout 10
```

### Pair with a device

```bash
toggldev pair --host <ip> --port <port> --code <code>
```

Saves authentication to `~/.toggldev/config.json` (readable only by you where the OS supports it).

- The file holds a bearer token that controls the phone. Don't commit or share it.
- A phone keeps **one** token: pairing from a second machine invalidates the first machine's token (you will see an "Authentication failed" error). Copy the config file between machines instead of pairing twice.
- Traffic to the phone is plain HTTP. Use it on a network you trust, or over Tailscale (see [Remote Access](#remote-access)).
- Requests time out after 8 seconds; set `TOGGLDEV_TIMEOUT_MS` to change that.

### Several phones

Give each phone a name when you pair it, then pick it with `--device` (or `-d`) on any command:

```bash
toggldev pair --device fold --host <ip> --code <code>
toggldev pair --device tablet --host <ip> --code <code>

toggldev devices            # list paired phones (never shows tokens)
toggldev devices --check    # also ask each phone whether it is reachable
toggldev -d fold status
```

Named pairings live in `~/.toggldev/devices/<name>/config.json`. Without `--device`, commands use `$TOGGLDEV_CONFIG_DIR` if set, else `$TOGGLDEV_DEVICE` if set, else `~/.toggldev/config.json`, else the only named phone if there is just one. `--device default` means the `~/.toggldev/config.json` pairing. With several named phones and no default, the command stops and asks which one rather than guess. `TOGGLDEV_CONFIG_DIR` (one directory per pairing) and `TOGGLDEV_DEVICES_DIR` (where named pairings live) override the locations.

If a phone's IP changes (DHCP), run `toggldev -d <name> relocate`. The app announces every phone as plain "TogglDev", so `relocate` offers the saved token to each phone it finds and keeps the one that accepts it. That sends the token over plain HTTP to every TogglDev phone on the network, so it only runs when you ask, on a network you trust.

### Get device status

```bash
toggldev status
```

### Toggle a setting

```bash
toggldev toggle --key adb_wifi_enabled --enabled true
```

The app replies "ok" without checking that Android applied the change, so the CLI reads the phone's status afterwards. The output has `"verified": true` when the new value is confirmed, `"verified": null` when the phone does not report that setting (unconfirmed), and the command fails when the value did not change.

Toggle keys: `development_settings_enabled`, `adb_enabled`, `adb_wifi_enabled`, `stay_on_while_plugged_in`, `always_finish_activities`, `debug.force_rtl`, `wait_for_debugger`, `force_resizable_activities`, `debug_view_attributes`, `mobile_data_always_on`, `enable_freeform_support`, `sysui_tuner_demo_on`. The names `status` reports for four of them also work (`developer_options_enabled`, `force_rtl`, `freeform_windows`, `demo_mode`). The phone rejects unknown keys.

### Set a setting value

```bash
toggldev set --key window_animation_scale --value 0.5
```

Keys: `window_animation_scale`, `transition_animation_scale`, `animator_duration_scale`, `debug_app`, `overlay_display_devices`. The result is verified the same way.

### Connect ADB over Wi-Fi

```bash
toggldev connect-adb          # turns wireless debugging on if needed, runs adb connect
adb -s <serial> ...           # use the serial it prints
toggldev disconnect-adb       # disconnects and turns wireless debugging off
```

The wireless debugging port changes whenever adb restarts on the phone, so `connect-adb` reads it fresh each time. The port the app reports can occasionally belong to another phone on the network, so it prefers the port adb itself finds for that phone's IP (via `adb mdns services`) and falls back to the app's port only if adb sees none. It confirms with `adb get-state` that the phone is really usable, and says so if this computer's adb key is not authorised. Set `ADB` to the adb binary if it is not on `PATH`.

### Get wireless debugging info

```bash
toggldev wireless-debug-info
```

Shows the IP and port exactly as the app reports them. Prefer `connect-adb`: this port can be stale or wrong.

---

## AI Agent Setup (MCP)

Use toggldev-remote as a tool provider for any MCP-compatible AI assistant.

### Claude Code

```bash
claude mcp add toggldev toggldev-mcp
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "toggldev": {
      "command": "toggldev-mcp",
      "args": []
    }
  }
}
```

### Cursor IDE

1. **Settings** > **Features** > **MCP**
2. **+ Add New MCP Server**
3. Type: `command`, Command: `toggldev-mcp`

### Gemini CLI / Other MCP Clients

Point your MCP configuration to:

```bash
toggldev-mcp
```

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_devices` | List paired phones; with `check`, which are reachable now |
| `discover_devices` | Find TogglDev instances on the local network |
| `pair_device` | Pair with a device using host, pairing code and (optionally) a name |
| `get_status` | Get current developer options status |
| `toggle_setting` | Toggle a boolean setting (e.g. `adb_wifi_enabled`) and confirm it took effect |
| `set_setting` | Set a value for a setting (e.g. `window_animation_scale` to `0.5`) and confirm it |
| `connect_adb` | Turn on wireless debugging if needed, `adb connect`, and return the serial |
| `disconnect_adb` | Disconnect adb and turn wireless debugging off |
| `get_wireless_debug_info` | Raw IP and port as the app reports them (use `connect_adb` to connect) |

Every tool except `list_devices` and `discover_devices` takes an optional `device` name.

---

## Remote Access

By default, discovery and control work over the local network. To control your device from anywhere:

1. Install [Tailscale](https://tailscale.com/download) on your PC and Android phone
2. Sign in on both with the same account
3. Note your phone's Tailscale IP (usually `100.x.x.x`)
4. Pair using that IP:
   ```bash
   toggldev pair --host 100.x.x.x --port 8734 --code <code>
   ```

Once paired, all commands work from any network. The Tailscale IP stays stable across network changes.

> **Note:** `toggldev discover` uses mDNS, which doesn't work over Tailscale. Use the Tailscale IP directly for pairing.

---

## Development

```bash
npm install
npm run build
npm test            # unit tests against a fake phone, a fake adb, and responses captured from real phones
npm run live        # read-only check of this build against your paired phones
```

- `npm run live -- --same-value-writes --connect-adb` also writes each setting's current value (expecting `verified: true`) and runs `connect-adb` plus a shell command. `--disconnect-adb` turns wireless debugging off, so it is never implied.
- `tests/fixtures/` holds `/status` and error responses captured from released TogglDev builds, with IPs replaced by documentation addresses and no token. After a new app release, add its fixture with `node scripts/capture-fixtures.mjs <device> --app-version <x.y>`; the compatibility tests then run against it.
