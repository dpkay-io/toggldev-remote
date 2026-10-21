import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AddressInfo } from "node:net";
import { api, TogglDevError } from "../src/core/api.js";
import { saveConfig, loadConfig, listDeviceNames, getConfigPath } from "../src/core/config.js";
import { connectAdb } from "../src/core/adb.js";
import { statefulPhone, fakePhone, json } from "./helpers.js";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = ["HOME", "USERPROFILE", "TOGGLDEV_CONFIG_DIR", "TOGGLDEV_DEVICES_DIR", "TOGGLDEV_DEVICE", "TOGGLDEV_VERIFY", "TOGGLDEV_TIMEOUT_MS", "ADB", "FAKE_ADB_CONFIG"];
const saved: Record<string, string | undefined> = {};
let home: string;

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "toggldev-review-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(home, { recursive: true, force: true });
});

const cli = (...args: string[]) =>
  run(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], { cwd: ROOT, env: process.env });
const cfg = (token: string, port: number) => ({ host: "127.0.0.1", port, token });

describe("a phone that sends headers and then stalls", () => {
  it("gives the readable timeout error, not a raw abort", async () => {
    const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.TOGGLDEV_TIMEOUT_MS = "300";
    saveConfig(cfg("t", (server.address() as AddressInfo).port));
    const err = await api.getStatus().catch((e) => e);
    expect(err).toBeInstanceOf(TogglDevError);
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/No response from/);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
});

describe("the name 'default'", () => {
  it("selects the default pairing, as list_devices shows it", async () => {
    const phone = await statefulPhone({ who: "default-phone" });
    saveConfig(cfg("t", phone.port)); // ~/.toggldev/config.json
    saveConfig(cfg("t", 1), "other");
    expect((await api.getStatus("default")).who).toBe("default-phone");
    expect((await api.listDevices()).map((d) => d.name)).toEqual(["default", "other"]);
    await phone.close();
  });

  it("follows TOGGLDEV_CONFIG_DIR and can be saved by name", () => {
    process.env.TOGGLDEV_CONFIG_DIR = path.join(home, "somewhere");
    saveConfig(cfg("t", 5), "default");
    expect(getConfigPath("default")).toBe(path.join(home, "somewhere", "config.json"));
    expect(loadConfig("default").port).toBe(5);
  });

  it("is never listed twice if devices/default exists on disk", () => {
    fs.mkdirSync(path.join(home, ".toggldev", "devices", "default"), { recursive: true });
    fs.writeFileSync(path.join(home, ".toggldev", "devices", "default", "config.json"), JSON.stringify(cfg("t", 1)));
    expect(listDeviceNames()).toEqual([]);
  });
});

describe("the 401 message", () => {
  it("still begins with the wording earlier versions used", async () => {
    const phone = await fakePhone((_r, _b, res) => json(res, 401, { error: "Invalid token" }));
    saveConfig(cfg("t", phone.port));
    await expect(api.getStatus()).rejects.toThrow(/^Authentication failed\. Token is invalid or expired\. Please pair again\./);
    await phone.close();
  });
});

describe("turning verification off restores the earlier behaviour", () => {
  it("returns the app's reply untouched and never reads /status (option, env, and CLI flag)", async () => {
    const phone = await statefulPhone({ adb_wifi_enabled: false }, { apply: () => {} }); // a phone that reverts
    saveConfig(cfg("t", phone.port));
    expect(await api.toggleSetting("adb_wifi_enabled", true, undefined, { verify: false })).toEqual({ ok: true, key: "adb_wifi_enabled" });
    process.env.TOGGLDEV_VERIFY = "0";
    expect(await api.setSetting("window_animation_scale", "0.5")).toEqual({ ok: true, key: "window_animation_scale" });
    delete process.env.TOGGLDEV_VERIFY;
    expect(phone.requests.filter((r) => r.url === "/status")).toHaveLength(0);

    process.env.TOGGLDEV_CONFIG_DIR = path.join(home, ".toggldev");
    const { stdout } = await cli("toggle", "--key", "adb_wifi_enabled", "--enabled", "true", "--no-verify");
    expect(JSON.parse(stdout)).toEqual({ ok: true, key: "adb_wifi_enabled" });
    await phone.close();
  });
});

describe("CLI --device", () => {
  it("reaches the named phone whether it comes before or after the command", async () => {
    const one = await statefulPhone({ who: "one" });
    const two = await statefulPhone({ who: "two" });
    saveConfig(cfg("t", one.port), "one");
    saveConfig(cfg("t", two.port), "two");
    saveConfig(cfg("t", one.port)); // default = one
    expect(JSON.parse((await cli("-d", "two", "status")).stdout).who).toBe("two");
    expect(JSON.parse((await cli("status", "-d", "two")).stdout).who).toBe("two");
    expect(JSON.parse((await cli("status", "--device", "two")).stdout).who).toBe("two");
    expect(JSON.parse((await cli("status")).stdout).who).toBe("one");
    await one.close();
    await two.close();
  });

  it("rejects a bad port for pair", async () => {
    await expect(cli("pair", "--host", "127.0.0.1", "--port", "abc", "--code", "1")).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('Invalid port "abc"')
    });
  });
});

describe("saveConfig failure", () => {
  it("removes its temporary file", () => {
    const dir = path.join(home, ".toggldev");
    fs.mkdirSync(path.join(dir, "config.json"), { recursive: true }); // a directory where the file should go
    expect(() => saveConfig(cfg("t", 1))).toThrow();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("a stale adb entry", () => {
  it("is disconnected when adb reports it offline", async () => {
    const bin = path.join(home, "adb");
    const log = path.join(home, "calls.log");
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");
if (a[0] === "mdns") console.log("x\\nadb-a\\t_adb-tls-connect._tcp\\t192.168.0.50:42815");
else if (a[0] === "connect") console.log("already connected to " + a[1]);
else if (a[0] === "disconnect") console.log("disconnected " + a[1]);
else if (a[2] === "get-state") { console.error("error: device offline"); process.exit(1); }
`, { mode: 0o755 });
    process.env.ADB = bin;
    const phone = await statefulPhone({ adb_wifi_enabled: true }, {
      wirelessDebug: () => ({ enabled: true, ip: "192.168.0.50", port: 42815 })
    });
    saveConfig(cfg("t", phone.port));
    await expect(connectAdb(undefined, { attempts: 2, delayMs: 5 })).rejects.toThrow(/sees the phone as offline/);
    expect(fs.readFileSync(log, "utf8")).toContain("disconnect 192.168.0.50:42815");
    await phone.close();
  });
});
