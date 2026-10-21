import { Bonjour } from "bonjour-service";
import fs from "node:fs";
import path from "node:path";
import {
  loadConfig, saveConfig, listDeviceNames, readConfigFile, defaultConfigPath, devicesRoot,
  DEFAULT_DEVICE, Config
} from "./config.js";
import { sleep, toToggleKey, toStatusKey } from "./util.js";

export interface DeviceInfo {
  host: string;
  port: number;
}

export type ErrorKind = "timeout" | "refused" | "unreachable" | "unauthorized" | "rate_limited" | "http" | "network" | "verify";

/** Error with a machine-readable kind, so callers can react (e.g. report an unreachable phone) without parsing text. */
export class TogglDevError extends Error {
  constructor(message: string, public kind: ErrorKind) {
    super(message);
    this.name = "TogglDevError";
  }
}

export interface RequestOptions {
  timeoutMs?: number;
}

export interface VerifyOptions {
  /** How long to wait for /status to show the new value (default 3000ms). */
  verifyTimeoutMs?: number;
  /** false: send the change and return the app's reply untouched, as versions before 1.1 did. Also TOGGLDEV_VERIFY=0. */
  verify?: boolean;
}

function verificationOff(options: VerifyOptions): boolean {
  return options.verify === false || process.env.TOGGLDEV_VERIFY === "0";
}

const DEFAULT_TIMEOUT_MS = 8000;

function requestTimeoutMs(): number {
  const fromEnv = Number(process.env.TOGGLDEV_TIMEOUT_MS);
  return fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
}

/** Turn a low-level fetch failure into a message that says what to check. */
function describeNetworkError(host: string, port: number, err: any, timeoutMs: number): TogglDevError {
  const target = `${host}:${port}`;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new TogglDevError(
      `No response from ${target} within ${timeoutMs / 1000}s. The phone may be asleep or on a different network, or the TogglDev remote access server may be stopped.`,
      "timeout"
    );
  }
  const code = err?.cause?.code ?? err?.code;
  if (code === "ECONNREFUSED") {
    return new TogglDevError(
      `Connection refused by ${target}. The phone is reachable but TogglDev's remote access server is not running; open the app and start it.`,
      "refused"
    );
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new TogglDevError(
      `Cannot reach ${target} (${code}). Check the phone is on the same network (or use its Tailscale IP); a DHCP lease may have changed its address.`,
      "unreachable"
    );
  }
  return new TogglDevError(`Request to ${target} failed: ${err?.cause?.message ?? err?.message ?? err}`, "network");
}

function retryAfterSuffix(text: string): string {
  try {
    const seconds = JSON.parse(text).retry_after_seconds;
    if (typeof seconds === "number") return ` Try again in about ${Math.ceil(seconds)}s.`;
  } catch (e) {}
  return "";
}

export class TogglDevAPI {
  /** fetch with a timeout (covering the response body too) and readable network errors. */
  private async send(host: string, port: number, urlPath: string, init: RequestInit, options: RequestOptions = {}) {
    const timeoutMs = options.timeoutMs ?? requestTimeoutMs();
    try {
      const response = await fetch(`http://${host}:${port}${urlPath}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs)
      });
      return { status: response.status, ok: response.ok, text: await response.text() };
    } catch (err: any) {
      throw describeNetworkError(host, port, err, timeoutMs);
    }
  }

  async apiRequest(config: Config, method: string, urlPath: string, body?: any, options: RequestOptions = {}) {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${config.token}`
    };
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await this.send(config.host, config.port, urlPath, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    }, options);

    if (response.status === 401) {
      // the first sentence is the wording earlier versions used; scripts may match it
      throw new TogglDevError(
        `Authentication failed. Token is invalid or expired. Please pair again. (${config.host}: a phone keeps only one pairing token, so this usually means it was paired again from another machine, or its pairing was reset.)`,
        "unauthorized"
      );
    }

    if (!response.ok) {
      throw new TogglDevError(`Request failed: ${response.status} ${response.text}`, "http");
    }

    try {
      return JSON.parse(response.text);
    } catch (e) {
      return response.text;
    }
  }

  async discoverDevices(timeoutSeconds = 5): Promise<DeviceInfo[]> {
    const bonjour = new Bonjour();
    const found = new Map<string, DeviceInfo>();

    const browser = bonjour.find({ type: "toggldev" }, (service: any) => {
      const ipv4 = service.addresses?.find((a: string) => !a.includes(":"));
      const host = ipv4 || service.addresses?.[0] || service.host;
      // the same phone is announced several times (once per interface/record); report it once
      found.set(`${host}:${service.port}`, { host, port: service.port });
    });

    await sleep(timeoutSeconds * 1000);
    browser.stop();
    bonjour.destroy();

    return [...found.values()];
  }

  /** Pair with a phone. With `device`, the pairing is saved under that name and other phones are left alone. */
  async pairDevice(host: string, port: number, code: string, device?: string): Promise<string> {
    const response = await this.send(host, port, "/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    const text = response.text;

    if (response.status === 429) {
      throw new TogglDevError(`Pairing refused: too many attempts.${retryAfterSuffix(text)} Not retrying, so the lockout is not extended.`, "rate_limited");
    }
    if (!response.ok) {
      throw new TogglDevError(`Pairing failed: ${response.status} ${text}`, "http");
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Pairing failed: unexpected response from ${host}:${port}: ${text.slice(0, 200)}`);
    }
    if (!data.token) {
      throw new Error("Pairing failed: no token in response");
    }

    saveConfig({ host, port, token: data.token }, device);
    return device
      ? `Paired successfully as "${device}". Configuration saved.`
      : "Paired successfully. Configuration saved.";
  }

  async getStatus(device?: string) {
    const config = loadConfig(device);
    return this.apiRequest(config, "GET", "/status");
  }

  /**
   * Poll /status until `statusKey` satisfies `matches` or the wait runs out.
   * The app answers {"ok":true} without checking the value stuck, so this is the only proof.
   */
  private async waitForStatus(config: Config, statusKey: string, matches: (actual: any) => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.apiRequest(config, "GET", "/status");
      if (!status || typeof status !== "object" || !(statusKey in status)) return { present: false as const };
      const actual = status[statusKey];
      if (matches(actual) || Date.now() >= deadline) return { present: true as const, actual, matched: matches(actual) };
      await sleep(400);
    }
  }

  /**
   * Switch a boolean setting and confirm the phone really changed. Throws if the app said ok but
   * /status still shows the old value (Android can revert a change). Settings that /status does not
   * report, or reports as non-boolean text, come back with verified: null.
   */
  async toggleSetting(key: string, enabled: boolean, device?: string, options: VerifyOptions = {}) {
    const config = loadConfig(device);
    const toggleKey = toToggleKey(key);
    const result = await this.apiRequest(config, "POST", `/toggle/${encodeURIComponent(toggleKey)}`, { enabled });
    if (verificationOff(options)) return result;
    const statusKey = toStatusKey(toggleKey);

    let check;
    try {
      check = await this.waitForStatus(config, statusKey, (v) => asBoolean(v) === enabled, options.verifyTimeoutMs ?? 3000);
    } catch (e: any) {
      return { ...result, verified: null, note: `could not read status to verify: ${e.message}` };
    }
    if (!check.present) {
      return { ...result, verified: null, note: `/status does not report "${statusKey}", so the change is unconfirmed` };
    }
    if (asBoolean(check.actual) === undefined) {
      return { ...result, verified: null, actual: check.actual, note: `"${statusKey}" is not a boolean in /status, so the change is unconfirmed` };
    }
    if (!check.matched) {
      throw new TogglDevError(
        `The phone accepted the request but "${statusKey}" is still ${JSON.stringify(check.actual)} after ${(options.verifyTimeoutMs ?? 3000) / 1000}s (wanted ${enabled}). Android or the app reverted the change; try again, and check the phone for a prompt.`,
        "verify"
      );
    }
    return { ...result, verified: true, actual: check.actual };
  }

  /** Set a numeric or text setting and confirm it through /status where the phone reports it. */
  async setSetting(key: string, value: string, device?: string, options: VerifyOptions = {}) {
    const config = loadConfig(device);
    let parsedValue: any = value;
    try { parsedValue = JSON.parse(value); } catch (e) {}
    const result = await this.apiRequest(config, "POST", `/set/${encodeURIComponent(key)}`, { value: parsedValue });
    if (verificationOff(options)) return result;

    let check;
    try {
      check = await this.waitForStatus(config, key, (v) => sameValue(v, parsedValue), options.verifyTimeoutMs ?? 3000);
    } catch (e: any) {
      return { ...result, verified: null, note: `could not read status to verify: ${e.message}` };
    }
    if (!check.present) {
      return { ...result, verified: null, note: `/status does not report "${key}", so the change is unconfirmed` };
    }
    if (!check.matched) {
      throw new TogglDevError(
        `The phone accepted the request but "${key}" is ${JSON.stringify(check.actual)} (wanted ${JSON.stringify(parsedValue)}).`,
        "verify"
      );
    }
    return { ...result, verified: true, actual: check.actual };
  }

  async getWirelessDebugInfo(device?: string) {
    const config = loadConfig(device);
    return this.apiRequest(config, "GET", "/wireless-debug-info");
  }

  /** Saved phones (never their tokens). With `check`, each is asked for /status so you can see which are reachable. */
  async listDevices(check = false): Promise<DeviceSummary[]> {
    const entries: { name: string; file: string; isDefault?: boolean }[] = [];
    if (fs.existsSync(defaultConfigPath())) entries.push({ name: DEFAULT_DEVICE, file: defaultConfigPath(), isDefault: true });
    for (const name of listDeviceNames()) entries.push({ name, file: path.join(devicesRoot(), name, "config.json") });

    return Promise.all(entries.map(async (entry): Promise<DeviceSummary> => {
      let config: Config;
      try {
        config = readConfigFile(entry.file);
      } catch (e: any) {
        return { name: entry.name, error: e.message };
      }
      const summary: DeviceSummary = { name: entry.name, host: config.host, port: config.port };
      if (!check) return summary;
      try {
        const status = await this.apiRequest(config, "GET", "/status", undefined, { timeoutMs: 3000 });
        return { ...summary, reachable: true, adb_wifi_enabled: status?.adb_wifi_enabled };
      } catch (e: any) {
        return { ...summary, reachable: false, error: e.message, errorKind: e.kind };
      }
    }));
  }

  /**
   * Find a saved phone again after its IP changed. The app announces every phone as plain "TogglDev",
   * so the only way to tell them apart is to offer the saved token: this sends it over plain HTTP to
   * each phone found on the network, which is why it is only ever run on request.
   */
  async relocateDevice(device?: string, candidates?: DeviceInfo[], timeoutSeconds = 5) {
    const config = loadConfig(device);
    const found = candidates ?? (await this.discoverDevices(timeoutSeconds));
    if (found.length === 0) throw new Error("No TogglDev phones found on this network.");
    for (const candidate of found) {
      try {
        await this.apiRequest({ ...config, host: candidate.host, port: candidate.port }, "GET", "/status", undefined, { timeoutMs: 3000 });
      } catch (e) {
        continue; // wrong phone (401), unreachable, or slow: try the next one
      }
      saveConfig({ ...config, host: candidate.host, port: candidate.port }, device);
      return { host: candidate.host, port: candidate.port, previousHost: config.host, changed: candidate.host !== config.host };
    }
    throw new Error(`None of the ${found.length} TogglDev phone(s) found accepted the saved token.`);
  }
}

export interface DeviceSummary {
  name: string;
  host?: string;
  port?: number;
  reachable?: boolean;
  adb_wifi_enabled?: boolean;
  error?: string;
  errorKind?: ErrorKind;
}

/** /status reports some on/off settings as booleans and others as 0/non-zero integers. */
function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return undefined;
}

function sameValue(actual: unknown, wanted: unknown): boolean {
  if (typeof actual === "number" && typeof wanted === "number") return Math.abs(actual - wanted) < 1e-4;
  const norm = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return norm(actual) === norm(wanted);
}

export const api = new TogglDevAPI();
