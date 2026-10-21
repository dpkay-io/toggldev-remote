import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { api, TogglDevError } from "../src/core/api.js";
import { saveConfig } from "../src/core/config.js";
import { chooseAdbPorts, parseMdnsServices } from "../src/core/adb.js";
import { KNOWN_TOGGLE_KEYS, KNOWN_SET_KEYS, toStatusKey } from "../src/core/util.js";
import { fixturePhone, statefulPhone, type Fixture } from "./helpers.js";

// Responses captured from real phones running released TogglDev builds (scripts/capture-fixtures.mjs).
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixtures: [string, Fixture][] = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => [f.replace(/\.json$/, ""), JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"))]);

let cfgDir: string;
beforeEach(() => {
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "toggldev-compat-"));
  process.env.TOGGLDEV_CONFIG_DIR = cfgDir;
});
afterEach(() => {
  delete process.env.TOGGLDEV_CONFIG_DIR;
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

const FAST = { verifyTimeoutMs: 800 };
const typeOf = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v]));

it("has fixtures from at least two app versions", () => {
  expect(new Set(fixtures.map(([, f]) => f.app_version)).size).toBeGreaterThanOrEqual(2);
});

describe("across app versions", () => {
  it("report the same status keys, value types and error bodies", () => {
    const [[firstName, first], ...rest] = fixtures;
    for (const [name, f] of rest) {
      expect(Object.keys(f.status).sort(), `${name} vs ${firstName}`).toEqual(Object.keys(first.status).sort());
      expect(typeOf(f.status), name).toEqual(typeOf(first.status));
      expect(f.errors.bad_token, name).toEqual(first.errors.bad_token);
      expect(f.errors.unknown_key.status, name).toBe(first.errors.unknown_key.status);
      expect(f.errors.missing_enabled, name).toEqual(first.errors.missing_enabled);
    }
  });
});

describe.each(fixtures)("client against %s", (_name, fixture) => {
  const connect = async () => {
    const phone = await fixturePhone(fixture);
    saveConfig({ host: "127.0.0.1", port: phone.port, token: "t" });
    return phone;
  };

  it("reads the status the phone really returns", async () => {
    const phone = await connect();
    expect(await api.getStatus()).toEqual(fixture.status);
    await phone.close();
  });

  it("finds every key it verifies against in /status", () => {
    for (const key of [...KNOWN_TOGGLE_KEYS, ...KNOWN_SET_KEYS]) {
      expect(fixture.status, `/status key for ${key}`).toHaveProperty(toStatusKey(key));
    }
  });

  it("reports wireless debugging info in the shape connect-adb expects", () => {
    const info = fixture.wireless_debug_info;
    expect(info).toMatchObject({ enabled: true, ip: expect.any(String), port: expect.any(Number) });
    expect(fixture.status.wireless_debug_ip).toBe(info.ip);
    expect(fixture.status.wireless_debug_port).toBe(info.port);
  });

  it("verifies every known toggle switched on and off", async () => {
    const phone = await connect();
    for (const key of KNOWN_TOGGLE_KEYS) {
      for (const enabled of [true, false, true]) {
        const result = await api.toggleSetting(key, enabled, undefined, FAST);
        expect(result, `${key} -> ${enabled}`).toMatchObject({ ok: true, verified: true });
      }
    }
    await phone.close();
  });

  it("verifies every known set key", async () => {
    const phone = await connect();
    for (const [key, value] of [
      ["window_animation_scale", "1.5"], ["transition_animation_scale", "0"], ["animator_duration_scale", "0.5"],
      ["debug_app", "\"com.example.app\""], ["overlay_display_devices", "\"1920x1080/320\""]
    ]) {
      expect(await api.setSetting(key, value, undefined, FAST), key).toMatchObject({ ok: true, verified: true });
    }
    await phone.close();
  });

  it("accepts the /status spelling of the four renamed settings", async () => {
    const phone = await connect();
    for (const key of ["developer_options_enabled", "force_rtl", "freeform_windows", "demo_mode"]) {
      expect(await api.toggleSetting(key, true, undefined, FAST), key).toMatchObject({ verified: true });
    }
    await phone.close();
  });

  it("turns the phone's 401 into an 'unauthorized' error", async () => {
    const phone = await fixturePhone(fixture, "the-real-token");
    saveConfig({ host: "127.0.0.1", port: phone.port, token: "stale" });
    const err = await api.getStatus().catch((e) => e);
    expect(err).toBeInstanceOf(TogglDevError);
    expect(err.kind).toBe("unauthorized");
    await phone.close();
  });

  it("surfaces the phone's own message for an unknown key", async () => {
    const phone = await connect();
    const err = await api.toggleSetting("show_touches", true, undefined, FAST).catch((e) => e);
    expect(err.kind).toBe("http");
    expect(err.message).toMatch(/400.*Unknown key: show_touches/);
    await phone.close();
  });

  it("copes with a newer app that adds status keys", async () => {
    const phone = await connect();
    phone.state.some_future_setting = true;
    expect(await api.getStatus()).toHaveProperty("some_future_setting", true);
    expect(await api.toggleSetting("adb_wifi_enabled", true, undefined, FAST)).toMatchObject({ verified: true });
    await phone.close();
  });

  it("copes with an older app that lacks the wireless_debug_* status keys", async () => {
    const phone = await connect();
    delete phone.state.wireless_debug_ip;
    delete phone.state.wireless_debug_port;
    expect(await api.toggleSetting("adb_wifi_enabled", true, undefined, FAST)).toMatchObject({ verified: true });
    expect((await api.listDevices(true))[0]).toMatchObject({ reachable: true });
    await phone.close();
  });
});

describe("wrong port from the app (seen on real phones, 2026-10-21)", () => {
  // The tablet's app reported 45331 for the tablet's IP; adb's mDNS lists 45331 on the A52, 33041 on the tablet.
  const TABLET = "192.0.2.20";
  const A52 = "192.0.2.30";
  const mdns = parseMdnsServices(
    "List of discovered mdns services\n" +
    `adb-tablet\t_adb-tls-connect._tcp\t${TABLET}:33041\n` +
    `adb-a52\t_adb-tls-connect._tcp\t${A52}:45331`
  );

  it("connects to the tablet's own port and warns about the A52's", () => {
    const { candidates, warnings } = chooseAdbPorts(TABLET, 45331, mdns);
    expect(candidates).toEqual([{ port: 33041, source: "mdns" }]);
    expect(warnings[0]).toContain(`adb sees that port on ${A52}`);
  });

  it("still connects the A52 normally", () => {
    expect(chooseAdbPorts(A52, 45331, mdns).candidates).toEqual([{ port: 45331, source: "mdns" }]);
  });
});
