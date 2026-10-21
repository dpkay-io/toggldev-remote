import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AddressInfo } from "node:net";
import { api } from "../src/core/api.js";
import { getConfigPath, saveConfig, loadConfig } from "../src/core/config.js";
import { parseBoolean, packageVersion } from "../src/core/util.js";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

/** A fake TogglDev phone: records requests and answers with whatever the test supplies. */
async function fakePhone(handler: Handler) {
  const requests: { method?: string; url?: string; auth?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); })
  };
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toggldev-rob-"));
  process.env.TOGGLDEV_CONFIG_DIR = dir;
});
afterEach(() => {
  delete process.env.TOGGLDEV_CONFIG_DIR;
  delete process.env.TOGGLDEV_TIMEOUT_MS;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseBoolean", () => {
  it.each(["true", "True", "TRUE", " 1 ", "yes", "on", true])("accepts %s as true", (v) => {
    expect(parseBoolean(v)).toBe(true);
  });
  it.each(["false", "False", "FALSE", "0", "no", "off", false])("accepts %s as false", (v) => {
    expect(parseBoolean(v)).toBe(false);
  });
  it.each(["", "maybe", "tru", "2", undefined])("rejects %s", (v) => {
    expect(() => parseBoolean(v)).toThrow(/Invalid boolean/);
  });
});

describe("config files", () => {
  it("does not create the config directory just by reading", () => {
    const missing = path.join(dir, "nope");
    process.env.TOGGLDEV_CONFIG_DIR = missing;
    expect(() => loadConfig()).toThrow("Not paired");
    expect(fs.existsSync(missing)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("writes the token file as 0600 inside a 0700 directory", () => {
    const fresh = path.join(dir, "new", "device");
    process.env.TOGGLDEV_CONFIG_DIR = fresh;
    saveConfig({ host: "h", port: 1, token: "secret" });
    expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("tightens an existing world-readable config on save", () => {
    fs.writeFileSync(getConfigPath(), "{}", { mode: 0o644 });
    saveConfig({ host: "h", port: 1, token: "secret" });
    expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
    expect(loadConfig().token).toBe("secret");
  });

  it("reports a corrupt or incomplete config instead of a raw JSON error", () => {
    fs.writeFileSync(getConfigPath(), "{not json");
    expect(() => loadConfig()).toThrow(/Pair again/);
    fs.writeFileSync(getConfigPath(), JSON.stringify({ host: "h", port: 1 }));
    expect(() => loadConfig()).toThrow(/incomplete/);
  });
});

describe("requests against a fake phone", () => {
  it("times out on a phone that never answers", async () => {
    const phone = await fakePhone(() => {});
    process.env.TOGGLDEV_TIMEOUT_MS = "300";
    saveConfig({ host: "127.0.0.1", port: phone.port, token: "t" });
    const started = Date.now();
    await expect(api.getStatus()).rejects.toThrow(/No response from 127\.0\.0\.1:\d+ within 0\.3s/);
    expect(Date.now() - started).toBeLessThan(3000);
    await phone.close();
  });

  it("explains a refused connection", async () => {
    const phone = await fakePhone(() => {});
    const port = phone.port;
    await phone.close();
    saveConfig({ host: "127.0.0.1", port, token: "t" });
    await expect(api.getStatus()).rejects.toThrow(/Connection refused/);
  });

  it("explains a 401 as a re-pair, mentioning the one-token-per-phone cause", async () => {
    const phone = await fakePhone((_r, _b, res) => json(res, 401, { error: "Invalid token" }));
    saveConfig({ host: "127.0.0.1", port: phone.port, token: "stale" });
    await expect(api.getStatus()).rejects.toThrow(/only one pairing token/);
    await phone.close();
  });

  it("shows the lockout time on a 429 during pairing and does not retry", async () => {
    const phone = await fakePhone((_r, _b, res) => json(res, 429, { error: "rate limited", retry_after_seconds: 240 }));
    await expect(api.pairDevice("127.0.0.1", phone.port, "000000")).rejects.toThrow(/about 240s/);
    expect(phone.requests).toHaveLength(1);
    expect(fs.existsSync(getConfigPath())).toBe(false);
    await phone.close();
  });

  it("rejects a non-JSON pairing response without saving anything", async () => {
    const phone = await fakePhone((_r, _b, res) => { res.writeHead(200); res.end("<html>captive portal</html>"); });
    await expect(api.pairDevice("127.0.0.1", phone.port, "123456")).rejects.toThrow(/unexpected response/);
    expect(fs.existsSync(getConfigPath())).toBe(false);
    await phone.close();
  });
});

describe("CLI", () => {
  const cli = (...args: string[]) =>
    run(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], { cwd: ROOT, env: process.env });

  it.each([
    ["true", true], ["True", true], ["TRUE", true], ["1", true], ["yes", true],
    ["false", false], ["False", false], ["0", false], ["off", false]
  ])("toggle --enabled %s sends enabled=%s", async (arg, expected) => {
    const phone = await fakePhone((_r, _b, res) => json(res, 200, { ok: true }));
    saveConfig({ host: "127.0.0.1", port: phone.port, token: "t" });
    await cli("toggle", "--key", "show_touches", "--enabled", arg);
    expect(phone.requests[0].url).toBe("/toggle/show_touches");
    expect(JSON.parse(phone.requests[0].body)).toEqual({ enabled: expected });
    await phone.close();
  });

  it("refuses an unrecognised --enabled value and sends nothing", async () => {
    const phone = await fakePhone((_r, _b, res) => json(res, 200, { ok: true }));
    saveConfig({ host: "127.0.0.1", port: phone.port, token: "t" });
    await expect(cli("toggle", "--key", "show_touches", "--enabled", "maybe")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Invalid boolean")
    });
    expect(phone.requests).toHaveLength(0);
    await phone.close();
  });

  it("reports the package.json version", async () => {
    const { stdout } = await cli("--version");
    expect(stdout.trim()).toBe(packageVersion());
    expect(packageVersion()).toBe(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).version);
  });
});
