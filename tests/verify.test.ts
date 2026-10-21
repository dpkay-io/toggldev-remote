import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { api, TogglDevError } from "../src/core/api.js";
import { saveConfig } from "../src/core/config.js";
import { toToggleKey, toStatusKey } from "../src/core/util.js";
import { fakePhone, statefulPhone, json } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toggldev-verify-"));
  process.env.TOGGLDEV_CONFIG_DIR = dir;
});
afterEach(() => {
  delete process.env.TOGGLDEV_CONFIG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const pair = (port: number) => saveConfig({ host: "127.0.0.1", port, token: "t" });
const FAST = { verifyTimeoutMs: 1200 };

describe("key names", () => {
  it("maps the four settings whose /toggle and /status names differ, both ways", () => {
    expect(toStatusKey("debug.force_rtl")).toBe("force_rtl");
    expect(toToggleKey("force_rtl")).toBe("debug.force_rtl");
    expect(toToggleKey("developer_options_enabled")).toBe("development_settings_enabled");
    expect(toToggleKey("adb_wifi_enabled")).toBe("adb_wifi_enabled");
  });
});

describe("toggleSetting verification", () => {
  it("confirms a change that stuck", async () => {
    const phone = await statefulPhone({ adb_wifi_enabled: false });
    pair(phone.port);
    const result = await api.toggleSetting("adb_wifi_enabled", true, undefined, FAST);
    expect(result).toMatchObject({ ok: true, verified: true, actual: true });
    await phone.close();
  });

  it("fails when the phone says ok but the value reverts", async () => {
    const phone = await statefulPhone({ adb_wifi_enabled: false }, { apply: () => {} });
    pair(phone.port);
    const err = await api.toggleSetting("adb_wifi_enabled", true, undefined, { verifyTimeoutMs: 600 }).catch((e) => e);
    expect(err).toBeInstanceOf(TogglDevError);
    expect(err.kind).toBe("verify");
    expect(err.message).toMatch(/still false.*reverted/);
    await phone.close();
  });

  it("waits for a change that lands a moment later", async () => {
    const phone = await statefulPhone({ adb_wifi_enabled: false }, {
      apply: (k, v, s) => { setTimeout(() => { s[k] = v; }, 700); }
    });
    pair(phone.port);
    expect(await api.toggleSetting("adb_wifi_enabled", true, undefined, { verifyTimeoutMs: 3000 })).toMatchObject({ verified: true });
    await phone.close();
  });

  it("sends the name /toggle needs when given the name /status uses, and checks the status name", async () => {
    const phone = await statefulPhone({ force_rtl: false }, {
      apply: (k, v, s) => { if (k === "debug.force_rtl") s.force_rtl = v; }
    });
    pair(phone.port);
    expect(await api.toggleSetting("force_rtl", true, undefined, FAST)).toMatchObject({ verified: true });
    expect(phone.requests.find((r) => r.method === "POST")!.url).toBe("/toggle/debug.force_rtl");
    await phone.close();
  });

  it("treats a non-zero integer as on (stay_on_while_plugged_in is 0 or 3)", async () => {
    const phone = await statefulPhone({ stay_on_while_plugged_in: 0 }, {
      apply: (k, v, s) => { s[k] = v ? 3 : 0; }
    });
    pair(phone.port);
    expect(await api.toggleSetting("stay_on_while_plugged_in", true, undefined, FAST)).toMatchObject({ verified: true, actual: 3 });
    expect(await api.toggleSetting("stay_on_while_plugged_in", false, undefined, FAST)).toMatchObject({ verified: true, actual: 0 });
    await phone.close();
  });

  it("reports unverified, not success, when /status does not list the key", async () => {
    const phone = await statefulPhone({ adb_wifi_enabled: true }, { apply: () => {} });
    pair(phone.port);
    const result = await api.toggleSetting("some_new_key", true, undefined, FAST);
    expect(result).toMatchObject({ ok: true, verified: null });
    expect(result.note).toMatch(/does not report "some_new_key"/);
    await phone.close();
  });

  it("reports unverified when the status text is not boolean-like", async () => {
    const phone = await statefulPhone({ debug_app: "com.x" }, { apply: () => {} });
    pair(phone.port);
    expect(await api.toggleSetting("debug_app", true, undefined, FAST)).toMatchObject({ verified: null, actual: "com.x" });
    await phone.close();
  });

  it("reports unverified when the phone cannot be read back", async () => {
    let status = 0;
    const phone = await fakePhone((req, _b, res) => {
      if (req.method === "POST") return json(res, 200, { ok: true });
      status++;
      res.destroy();
    });
    pair(phone.port);
    const result = await api.toggleSetting("adb_wifi_enabled", true, undefined, FAST);
    expect(result).toMatchObject({ ok: true, verified: null });
    expect(result.note).toMatch(/could not read status/);
    expect(status).toBeGreaterThan(0);
    await phone.close();
  });
});

describe("setSetting verification", () => {
  it("confirms a float setting (float precision is tolerated)", async () => {
    const phone = await statefulPhone({ window_animation_scale: 1 }, {
      apply: (k, v, s) => { s[k] = Math.fround(v); }
    });
    pair(phone.port);
    expect(await api.setSetting("window_animation_scale", "0.3", undefined, FAST)).toMatchObject({ ok: true, verified: true });
    await phone.close();
  });

  it("fails when the phone reports a different value", async () => {
    const phone = await statefulPhone({ window_animation_scale: 1 }, { apply: () => {} });
    pair(phone.port);
    await expect(api.setSetting("window_animation_scale", "0.5", undefined, { verifyTimeoutMs: 600 })).rejects.toThrow(/is 1 \(wanted 0\.5\)/);
    await phone.close();
  });

  it("confirms text settings and treats null and empty as the same", async () => {
    const phone = await statefulPhone({ debug_app: null }, { apply: (k, v, s) => { s[k] = v; } });
    pair(phone.port);
    expect(await api.setSetting("debug_app", "\"\"", undefined, FAST)).toMatchObject({ verified: true });
    await phone.close();
  });
});
