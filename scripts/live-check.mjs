#!/usr/bin/env node
// Check this build of toggldev-remote against your real, paired phones (run after `npm run build`).
//
//   node scripts/live-check.mjs                     read-only: reachability, status keys, wireless-debug-info shape
//   node scripts/live-check.mjs --device fold,a52   only these paired phones (default: all named ones)
//   --same-value-writes   also toggle/set each setting to the value it already has and expect verified: true
//   --connect-adb         also run connect-adb and run a command over the connection
//   --disconnect-adb      also run disconnect-adb: turns wireless debugging OFF on each phone
//
// Exit code is 1 if any check fails. Writes use each setting's current value, and are skipped where the app
// could not write that value back unchanged.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { api } from "../build/core/api.js";
import { connectAdb, disconnectAdb } from "../build/core/adb.js";
import { KNOWN_TOGGLE_KEYS, KNOWN_SET_KEYS, toStatusKey } from "../build/core/util.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const wanted = args.includes("--device") ? args[args.indexOf("--device") + 1].split(",") : undefined;

// Writing the current value of these can still have side effects (restarts a live adb session, or
// also writes a second setting), so they are never touched here.
const NOT_REWRITTEN = {
  adb_wifi_enabled: "re-toggling a live session can restart it and change the port",
  adb_enabled: "re-toggling can drop adb connections",
  sysui_tuner_demo_on: "also writes sysui_demo_allowed"
};

let failures = 0;
const report = (state, device, check, detail = "") => {
  if (state === "FAIL") failures++;
  console.log(`${state.padEnd(4)}  ${device.padEnd(12)} ${check}${detail ? ` — ${detail}` : ""}`);
};
const attempt = async (device, check, fn) => {
  try {
    report("PASS", device, check, (await fn()) ?? "");
  } catch (e) {
    report("FAIL", device, check, e.message);
  }
};

const all = (await api.listDevices()).map((d) => d.name);
const names = wanted ?? (all.filter((n) => n !== "default").length ? all.filter((n) => n !== "default") : all);
if (names.length === 0) {
  console.error("No paired phones. Pair one first: toggldev pair --device <name> --host <ip> --code <code>");
  process.exit(2);
}

for (const device of names) {
  let status;
  await attempt(device, "reachable", async () => {
    status = await api.getStatus(device);
    return `${Object.keys(status).length} status keys`;
  });
  if (!status) continue;

  await attempt(device, "status has every key the client verifies against", async () => {
    const missing = [...KNOWN_TOGGLE_KEYS, ...KNOWN_SET_KEYS].map(toStatusKey).filter((k) => !(k in status));
    if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
  });

  await attempt(device, "wireless-debug-info shape", async () => {
    const info = await api.getWirelessDebugInfo(device);
    if (info.enabled === false) return "wireless debugging is off";
    if (typeof info.ip !== "string" || !Number.isInteger(info.port)) throw new Error(JSON.stringify(info));
    return `${info.ip}:${info.port} (as the app reports it)`;
  });

  if (flag("--same-value-writes")) {
    for (const key of KNOWN_TOGGLE_KEYS) {
      if (NOT_REWRITTEN[key]) { report("SKIP", device, `toggle ${key}`, NOT_REWRITTEN[key]); continue; }
      // the app writes 3 for "on", so any other non-zero value (1, 2) would be changed by this
      const value = status[toStatusKey(key)];
      if (key === "stay_on_while_plugged_in" && value !== 0 && value !== 3) {
        report("SKIP", device, `toggle ${key}`, `current value ${value} is neither 0 nor 3; writing "on" would change it`);
        continue;
      }
      await attempt(device, `toggle ${key} to its current value`, async () => {
        const current = status[toStatusKey(key)];
        const r = await api.toggleSetting(key, current !== false && current !== 0, device);
        if (r.verified !== true) throw new Error(`not verified: ${r.note ?? JSON.stringify(r)}`);
      });
    }
    for (const key of KNOWN_SET_KEYS) {
      await attempt(device, `set ${key} to its current value`, async () => {
        const r = await api.setSetting(key, JSON.stringify(status[key] ?? ""), device);
        if (r.verified !== true) throw new Error(`not verified: ${r.note ?? JSON.stringify(r)}`);
      });
    }
  }

  if (flag("--connect-adb")) {
    await attempt(device, "connect-adb and run a command", async () => {
      const result = await connectAdb(device);
      const { stdout } = await promisify(execFile)(process.env.ADB || "adb", ["-s", result.serial, "shell", "echo", "ok"], { timeout: 15000 });
      if (stdout.trim() !== "ok") throw new Error(`unexpected output: ${stdout}`);
      return `${result.serial} via ${result.source}${result.warnings.length ? `; ${result.warnings.join(" ")}` : ""}`;
    });
  }

  if (flag("--disconnect-adb")) {
    await attempt(device, "disconnect-adb", async () => {
      const r = await disconnectAdb(device);
      return `disconnected ${r.disconnected.join(", ") || "nothing"}; wireless debugging off`;
    });
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
