import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { api } from "../src/core/api.js";
import { getConfigPath } from "../src/core/config.js";

const TEST_DIR = path.join(os.tmpdir(), "toggldev-test");

describe("TogglDev API Core", () => {
  beforeEach(() => {
    process.env.TOGGLDEV_CONFIG_DIR = TEST_DIR;
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    delete process.env.TOGGLDEV_CONFIG_DIR;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("should fail to get status if not paired", async () => {
    await expect(api.getStatus()).rejects.toThrow("Not paired. Please pair with a device first.");
  });

  it("should pair device, save config, and use it for subsequent calls", async () => {
    // Mock fetch for pairing
    const mockFetch = vi.fn().mockImplementation(async (url: string, options: any) => {
      if (url === "http://192.168.1.100:8734/pair" && options.method === "POST") {
        return {
          ok: true,
          text: async () => JSON.stringify({ token: "test-token-123" })
        };
      }
      if (url === "http://192.168.1.100:8734/status" && options.method === "GET") {
        return {
          ok: true,
          text: async () => JSON.stringify({ adb_wifi_enabled: true })
        };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    vi.stubGlobal("fetch", mockFetch);

    const result = await api.pairDevice("192.168.1.100", 8734, "123456");
    expect(result).toBe("Paired successfully. Configuration saved.");

    // Config should be saved
    const configPath = getConfigPath();
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.host).toBe("192.168.1.100");
    expect(config.port).toBe(8734);
    expect(config.token).toBe("test-token-123");

    // Get status should now work using the saved config
    const status = await api.getStatus();
    expect(status).toEqual({ adb_wifi_enabled: true });

    // Verify fetch was called with correct auth header
    const statusCall = mockFetch.mock.calls.find(call => call[0] === "http://192.168.1.100:8734/status");
    expect(statusCall).toBeDefined();
    expect(statusCall![1].headers).toHaveProperty("Authorization", "Bearer test-token-123");
  });
});
