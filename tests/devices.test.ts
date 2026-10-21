import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { api } from "../src/core/api.js";
import { saveConfig, loadConfig, getConfigPath, listDeviceNames } from "../src/core/config.js";
import { statefulPhone, json, fakePhone } from "./helpers.js";

// discovery: the same phone is announced several times
vi.mock("bonjour-service", () => ({
  Bonjour: class {
    find(_opts: unknown, onUp: (s: unknown) => void) {
      const phone = { addresses: ["fe80::1", "192.168.0.50"], port: 8734 };
      onUp(phone);
      onUp(phone);
      onUp({ addresses: ["192.168.0.60"], port: 8734 });
      return { stop() {} };
    }
    destroy() {}
  }
}));

let home: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["HOME", "USERPROFILE", "TOGGLDEV_CONFIG_DIR", "TOGGLDEV_DEVICES_DIR", "TOGGLDEV_DEVICE"];

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "toggldev-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(home, { recursive: true, force: true });
});

const cfg = (token: string, port = 1) => ({ host: "127.0.0.1", port, token });

describe("named devices", () => {
  it("saves a named pairing under the devices directory and leaves the default alone", async () => {
    saveConfig(cfg("default-token"));
    const pairing = await fakePhone((_r, _b, res) => json(res, 200, { token: "tab-token" }));
    expect(await api.pairDevice("127.0.0.1", pairing.port, "123456", "tablet")).toMatch(/as "tablet"/);
    expect(loadConfig("tablet").token).toBe("tab-token");
    expect(loadConfig().token).toBe("default-token");
    expect(getConfigPath("tablet")).toBe(path.join(home, ".toggldev", "devices", "tablet", "config.json"));
    if (process.platform !== "win32") {
      expect(fs.statSync(getConfigPath("tablet")).mode & 0o777).toBe(0o600);
    }
    await pairing.close();
  });

  it.each(["../evil", "a/b", ".hidden", "x".repeat(65), "bad name"])("rejects the device name %j", (name) => {
    expect(() => getConfigPath(name)).toThrow(/Invalid device name/);
  });

  it("does not let a name escape the devices directory", () => {
    expect(() => saveConfig(cfg("x"), "../../escape")).toThrow(/Invalid device name/);
    expect(fs.existsSync(path.join(home, "escape"))).toBe(false);
  });

  it("uses the only named device when there is no default, and refuses to guess between several", () => {
    saveConfig(cfg("only"), "solo");
    expect(loadConfig().token).toBe("only");
    saveConfig(cfg("second"), "duo");
    expect(() => loadConfig()).toThrow(/Several devices are paired \(duo, solo\)/);
    expect(loadConfig("duo").token).toBe("second");
  });

  it("prefers the default pairing when one exists", () => {
    saveConfig(cfg("default-token"));
    saveConfig(cfg("a"), "a");
    saveConfig(cfg("b"), "b");
    expect(loadConfig().token).toBe("default-token");
  });

  it("names the paired devices when the one asked for is missing", () => {
    saveConfig(cfg("a"), "alpha");
    expect(() => loadConfig("beta")).toThrow(/No paired device named "beta"\. Paired devices: alpha/);
  });

  it("selects by TOGGLDEV_DEVICE and relocates the devices directory with TOGGLDEV_DEVICES_DIR", () => {
    saveConfig(cfg("a"), "alpha");
    saveConfig(cfg("b"), "beta");
    process.env.TOGGLDEV_DEVICE = "beta";
    expect(loadConfig().token).toBe("b");
    process.env.TOGGLDEV_DEVICES_DIR = path.join(home, "elsewhere");
    expect(listDeviceNames()).toEqual([]);
    saveConfig(cfg("z"), "zed");
    expect(listDeviceNames()).toEqual(["zed"]);
  });

  it("sends each request to the phone it was named for, with that phone's token", async () => {
    const one = await statefulPhone({ who: "one" }, { token: "t1" });
    const two = await statefulPhone({ who: "two" }, { token: "t2" });
    saveConfig(cfg("t1", one.port), "one");
    saveConfig(cfg("t2", two.port), "two");
    expect((await api.getStatus("one")).who).toBe("one");
    expect((await api.getStatus("two")).who).toBe("two");
    await one.close();
    await two.close();
  });
});

describe("listDevices", () => {
  it("never includes tokens, and says why a phone is not reachable", async () => {
    const good = await statefulPhone({ adb_wifi_enabled: true }, { token: "good-secret" });
    const rePaired = await statefulPhone({}, { token: "someone-elses" });
    const gone = await statefulPhone({});
    const gonePort = gone.port;
    await gone.close();
    saveConfig(cfg("good-secret", good.port), "good");
    saveConfig(cfg("stale-secret", rePaired.port), "stale");
    saveConfig(cfg("gone-secret", gonePort), "gone");
    fs.mkdirSync(path.dirname(getConfigPath("broken")), { recursive: true });
    fs.writeFileSync(getConfigPath("broken"), "{");

    const unchecked = await api.listDevices();
    expect(JSON.stringify(unchecked)).not.toMatch(/secret/);
    expect(unchecked.find((d) => d.name === "good")).toEqual({ name: "good", host: "127.0.0.1", port: good.port });

    const devices = await api.listDevices(true);
    const byName = Object.fromEntries(devices.map((d) => [d.name, d]));
    expect(JSON.stringify(devices)).not.toMatch(/secret/);
    expect(byName.good).toMatchObject({ reachable: true, adb_wifi_enabled: true });
    expect(byName.stale).toMatchObject({ reachable: false, errorKind: "unauthorized" });
    expect(byName.gone).toMatchObject({ reachable: false, errorKind: "refused" });
    expect(byName.broken.error).toMatch(/Cannot read/);
    await good.close();
    await rePaired.close();
  });

  it("lists the default pairing as 'default'", async () => {
    saveConfig(cfg("t"));
    expect((await api.listDevices()).map((d) => d.name)).toEqual(["default"]);
  });
});

describe("discoverDevices", () => {
  it("reports each phone once and prefers its IPv4 address", async () => {
    expect(await api.discoverDevices(0)).toEqual([
      { host: "192.168.0.50", port: 8734 },
      { host: "192.168.0.60", port: 8734 }
    ]);
  });
});

describe("relocateDevice", () => {
  it("finds the saved phone among others by its token and updates only the address", async () => {
    const other = await statefulPhone({}, { token: "somebody-elses" });
    const mine = await statefulPhone({ adb_wifi_enabled: false }, { token: "mine" });
    saveConfig({ host: "10.255.255.1", port: 8734, token: "mine" }, "phone");
    const result = await api.relocateDevice("phone", [
      { host: "127.0.0.1", port: other.port },
      { host: "127.0.0.1", port: mine.port }
    ]);
    expect(result).toMatchObject({ port: mine.port, previousHost: "10.255.255.1", changed: true });
    expect(loadConfig("phone")).toEqual({ host: "127.0.0.1", port: mine.port, token: "mine" });
    await other.close();
    await mine.close();
  });

  it("changes nothing when no discovered phone accepts the token", async () => {
    const other = await statefulPhone({}, { token: "somebody-elses" });
    saveConfig({ host: "10.255.255.1", port: 8734, token: "mine" }, "phone");
    await expect(api.relocateDevice("phone", [{ host: "127.0.0.1", port: other.port }])).rejects.toThrow(/None of the 1/);
    expect(loadConfig("phone").host).toBe("10.255.255.1");
    await other.close();
  });

  it("says so when nothing is found", async () => {
    saveConfig(cfg("t"), "phone");
    await expect(api.relocateDevice("phone", [])).rejects.toThrow(/No TogglDev phones found/);
  });
});
