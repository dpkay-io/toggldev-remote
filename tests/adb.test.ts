import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseMdnsServices, chooseAdbPorts, connectAdb, disconnectAdb } from "../src/core/adb.js";
import { saveConfig } from "../src/core/config.js";
import { statefulPhone } from "./helpers.js";

const PHONE_IP = "192.168.0.50";
const OTHER_IP = "192.168.0.60";

const mdns = (...entries: [string, string, number][]) =>
  "List of discovered mdns services\n" +
  entries.map(([ip, service, port]) => `adb-${ip.replace(/\./g, "")}\t${service}\t${ip}:${port}`).join("\n");

describe("parseMdnsServices", () => {
  it("reads name, service type, host and port, and skips the header", () => {
    const out = parseMdnsServices(mdns([PHONE_IP, "_adb-tls-connect._tcp", 42815], [OTHER_IP, "_adb-tls-pairing._tcp", 33041]));
    expect(out).toEqual([
      { name: "adb-192168050", service: "_adb-tls-connect._tcp", host: PHONE_IP, port: 42815 },
      { name: "adb-192168060", service: "_adb-tls-pairing._tcp", host: OTHER_IP, port: 33041 }
    ]);
  });

  it("handles IPv6 hosts and junk lines", () => {
    const out = parseMdnsServices("x\n\nadb-a\t_adb-tls-connect._tcp\tfe80::1:5555\nno-port\t_x\thost:abc\n");
    expect(out).toEqual([{ name: "adb-a", service: "_adb-tls-connect._tcp", host: "fe80::1", port: 5555 }]);
  });
});

describe("chooseAdbPorts", () => {
  const services = (...e: [string, string, number][]) => parseMdnsServices(mdns(...e));

  it("puts the port adb sees on this phone's own IP first", () => {
    const r = chooseAdbPorts(PHONE_IP, 40000, services([PHONE_IP, "_adb-tls-connect._tcp", 42815]));
    expect(r.candidates).toEqual([{ port: 42815, source: "mdns" }, { port: 40000, source: "app" }]);
    expect(r.warnings).toEqual([]);
  });

  it("drops an app-reported port that belongs to another phone (the wrong-port case)", () => {
    const r = chooseAdbPorts(PHONE_IP, 33041, services(
      [OTHER_IP, "_adb-tls-connect._tcp", 33041],
      [PHONE_IP, "_adb-tls-connect._tcp", 42815]
    ));
    expect(r.candidates).toEqual([{ port: 42815, source: "mdns" }]);
    expect(r.warnings[0]).toMatch(/33041.*192\.168\.0\.60/);
  });

  it("falls back to the app's port when adb's mDNS does not list the phone", () => {
    expect(chooseAdbPorts(PHONE_IP, 40000, []).candidates).toEqual([{ port: 40000, source: "app" }]);
  });

  it("does not list the same port twice", () => {
    const r = chooseAdbPorts(PHONE_IP, 42815, services([PHONE_IP, "_adb-tls-connect._tcp", 42815]));
    expect(r.candidates).toEqual([{ port: 42815, source: "mdns" }]);
  });

  it("ignores pairing-service entries", () => {
    expect(chooseAdbPorts(PHONE_IP, undefined, services([PHONE_IP, "_adb-tls-pairing._tcp", 1111])).candidates).toEqual([]);
  });
});

// A fake `adb` executable (node script) driven by a JSON file; every call is logged.
const FAKE_ADB = `#!/usr/bin/env node
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_ADB_CONFIG, "utf8"));
const a = process.argv.slice(2);
fs.appendFileSync(cfg.log, a.join(" ") + "\\n");
if (a[0] === "mdns") console.log(cfg.mdns);
else if (a[0] === "connect") {
  const port = Number(a[1].split(":")[1]);
  console.log(cfg.connectOk.includes(port) ? "connected to " + a[1] : "failed to connect to '" + a[1] + "': Connection refused");
} else if (a[0] === "disconnect") console.log("disconnected " + a[1]);
else if (a[0] === "-s" && a[2] === "get-state") {
  if (cfg.state === "device") console.log("device");
  else { console.error("error: device " + cfg.state + "."); process.exit(1); }
}
`;

describe.skipIf(process.platform === "win32")("connectAdb / disconnectAdb", () => {
  let dir: string;
  let adbConfig: { log: string; mdns: string; connectOk: number[]; state: string };
  const saved: Record<string, string | undefined> = {};
  const FAST = { attempts: 2, delayMs: 5, verifyTimeoutMs: 300 };
  const calls = () => (fs.existsSync(adbConfig.log) ? fs.readFileSync(adbConfig.log, "utf8").trim().split("\n") : []);

  beforeEach(() => {
    for (const k of ["ADB", "FAKE_ADB_CONFIG", "TOGGLDEV_CONFIG_DIR"]) saved[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "toggldev-adb-"));
    const bin = path.join(dir, "adb");
    fs.writeFileSync(bin, FAKE_ADB, { mode: 0o755 });
    adbConfig = { log: path.join(dir, "calls.log"), mdns: mdns([PHONE_IP, "_adb-tls-connect._tcp", 42815]), connectOk: [42815], state: "device" };
    fs.writeFileSync(path.join(dir, "adb.json"), JSON.stringify(adbConfig));
    process.env.ADB = bin;
    process.env.FAKE_ADB_CONFIG = path.join(dir, "adb.json");
    process.env.TOGGLDEV_CONFIG_DIR = path.join(dir, "cfg");
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const setAdb = (patch: Partial<typeof adbConfig>) => {
    Object.assign(adbConfig, patch);
    fs.writeFileSync(path.join(dir, "adb.json"), JSON.stringify(adbConfig));
  };
  /** A phone whose wireless-debug-info reports `appPort` for PHONE_IP while wifi debugging is on. */
  const phoneWith = async (wifi: boolean, appPort: number, apply?: any) => {
    const phone = await statefulPhone({ adb_wifi_enabled: wifi }, {
      apply,
      wirelessDebug: (s) => (s.adb_wifi_enabled ? { enabled: true, ip: PHONE_IP, port: appPort } : { enabled: false })
    });
    saveConfig({ host: "127.0.0.1", port: phone.port, token: "t" });
    return phone;
  };

  it("connects to the port adb sees for the phone and returns the serial", async () => {
    const phone = await phoneWith(true, 42815);
    const result = await connectAdb(undefined, FAST);
    expect(result).toMatchObject({ serial: `${PHONE_IP}:42815`, port: 42815, source: "mdns", warnings: [] });
    expect(phone.requests.some((r) => r.method === "POST")).toBe(false); // already on: not toggled
    await phone.close();
  });

  it("uses the right port when the app reports another phone's port", async () => {
    setAdb({
      mdns: mdns([OTHER_IP, "_adb-tls-connect._tcp", 33041], [PHONE_IP, "_adb-tls-connect._tcp", 42815]),
      connectOk: [33041, 42815]
    });
    const phone = await phoneWith(true, 33041);
    const result = await connectAdb(undefined, FAST);
    expect(result.serial).toBe(`${PHONE_IP}:42815`);
    expect(result.warnings[0]).toMatch(/33041.*192\.168\.0\.60/);
    expect(calls().filter((c) => c.startsWith("connect "))).toEqual([`connect ${PHONE_IP}:42815`]);
    await phone.close();
  });

  it("falls back to the app's port when adb's mDNS has nothing", async () => {
    setAdb({ mdns: "List of discovered mdns services", connectOk: [40000] });
    const phone = await phoneWith(true, 40000);
    expect(await connectAdb(undefined, FAST)).toMatchObject({ serial: `${PHONE_IP}:40000`, source: "app" });
    await phone.close();
  });

  it("switches wireless debugging on first when it is off", async () => {
    const phone = await phoneWith(false, 42815);
    expect((await connectAdb(undefined, FAST)).serial).toBe(`${PHONE_IP}:42815`);
    expect(phone.requests.find((r) => r.method === "POST")!.url).toBe("/toggle/adb_wifi_enabled");
    await phone.close();
  });

  it("says Android reverted it when wireless debugging will not stay on", async () => {
    const phone = await phoneWith(false, 42815, () => {});
    await expect(connectAdb(undefined, FAST)).rejects.toMatchObject({ kind: "verify", message: expect.stringMatching(/reverted/) });
    await phone.close();
  });

  it("explains an unauthorised adb key, and disconnects", async () => {
    setAdb({ state: "unauthorized" });
    const phone = await phoneWith(true, 42815);
    await expect(connectAdb(undefined, FAST)).rejects.toThrow(/unauthorized.*RSA prompt/);
    expect(calls()).toContain(`disconnect ${PHONE_IP}:42815`);
    await phone.close();
  });

  it("explains a failed adb connect with debugging on", async () => {
    setAdb({ connectOk: [] });
    const phone = await phoneWith(true, 42815);
    await expect(connectAdb(undefined, FAST)).rejects.toThrow(/did not succeed.*not authorised/);
    await phone.close();
  });

  it("gives a clear error when adb is not installed", async () => {
    process.env.ADB = path.join(dir, "no-such-adb");
    const phone = await phoneWith(true, 42815);
    await expect(connectAdb(undefined, FAST)).rejects.toThrow(/adb not found/);
    await phone.close();
  });

  it("disconnects adb and turns wireless debugging off", async () => {
    const phone = await phoneWith(true, 42815);
    const result = await disconnectAdb();
    expect(result).toMatchObject({ disconnected: [`${PHONE_IP}:42815`], adb_wifi_enabled: false, verified: true });
    expect(phone.state.adb_wifi_enabled).toBe(false);
    await phone.close();
  });

  it("disconnect is harmless when wireless debugging is already off", async () => {
    const phone = await phoneWith(false, 42815);
    expect(await disconnectAdb()).toMatchObject({ disconnected: [], adb_wifi_enabled: false });
    expect(calls().filter((c) => c.startsWith("disconnect"))).toEqual([]);
    await phone.close();
  });
});
