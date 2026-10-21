import { execFile } from "node:child_process";
import { api, TogglDevError } from "./api.js";
import { loadConfig } from "./config.js";
import { sleep } from "./util.js";

const CONNECT_SERVICE = "_adb-tls-connect._tcp";

export interface AdbService {
  name: string;
  service: string;
  host: string;
  port: number;
}

export interface ConnectOptions {
  /** Tries before giving up (default 10). */
  attempts?: number;
  /** Pause between tries in ms (default 2000). */
  delayMs?: number;
  /** How long to wait for the phone to confirm wireless debugging switched on (default 3000). */
  verifyTimeoutMs?: number;
}

export interface ConnectResult {
  serial: string;
  ip: string;
  port: number;
  /** Where the winning port came from: adb's own mDNS view of this phone, or the app. */
  source: "mdns" | "app";
  warnings: string[];
}

function adbBinary(): string {
  return process.env.ADB || "adb";
}

function runAdb(args: string[], timeoutMs = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(adbBinary(), args, { timeout: timeoutMs, windowsHide: true }, (err: any, stdout, stderr) => {
      if (err?.code === "ENOENT") {
        reject(new Error(`adb not found (${adbBinary()}). Install Android platform-tools and put adb on PATH, or set ADB to its full path.`));
        return;
      }
      resolve({ code: typeof err?.code === "number" ? err.code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Parse `adb mdns services`: "<name>\t<service type>\t<host>:<port>" per line. */
export function parseMdnsServices(output: string): AdbService[] {
  const services: AdbService[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const target = parts[parts.length - 1];
    const colon = target.lastIndexOf(":");
    const port = Number(target.slice(colon + 1));
    if (colon <= 0 || !Number.isInteger(port) || port <= 0) continue;
    services.push({ name: parts[0], service: parts[1], host: target.slice(0, colon), port });
  }
  return services;
}

/**
 * Work out which port to try for `ip`. The app's own lookup falls back to the first wireless-debugging
 * service it sees on the LAN, which can be another phone's, so adb's per-IP mDNS entry goes first.
 */
export function chooseAdbPorts(ip: string, appPort: number | undefined, services: AdbService[]) {
  const connect = services.filter((s) => s.service === CONNECT_SERVICE);
  const own = connect.filter((s) => s.host === ip).map((s) => s.port);
  const candidates: { port: number; source: "mdns" | "app" }[] = own.map((port) => ({ port, source: "mdns" as const }));
  const warnings: string[] = [];
  if (appPort && !own.includes(appPort)) {
    const owner = connect.find((s) => s.port === appPort);
    if (owner) {
      warnings.push(`The app reported port ${appPort} for ${ip}, but adb sees that port on ${owner.host}; ignoring it.`);
    } else {
      candidates.push({ port: appPort, source: "app" });
    }
  }
  return { candidates, warnings };
}

async function mdnsServices(): Promise<AdbService[]> {
  return parseMdnsServices((await runAdb(["mdns", "services"], 10000)).stdout);
}

async function deviceState(serial: string): Promise<string> {
  // right after `adb connect` a device can be briefly "offline" or still connecting
  let last = "";
  for (let i = 0; i < 4; i++) {
    const r = await runAdb(["-s", serial, "get-state"], 8000);
    last = (r.stdout + r.stderr).trim();
    if (r.code === 0 && last === "device") return "device";
    if (/unauthorized/i.test(last)) return "unauthorized";
    await sleep(500);
  }
  return last || "unknown";
}

/**
 * Turn on wireless debugging if needed and `adb connect` to the phone, returning the serial to use
 * with `adb -s`. The port changes whenever adb restarts on the phone, so it is read fresh each time.
 */
export async function connectAdb(device?: string, options: ConnectOptions = {}): Promise<ConnectResult> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 2000;
  loadConfig(device); // fail early with the "not paired" message

  // Only switch it on when it is off: toggling a live session can restart it and change the port.
  let enableError: TogglDevError | undefined;
  if ((await api.getStatus(device)).adb_wifi_enabled !== true) {
    for (let i = 0; i < 2; i++) {
      try {
        await api.toggleSetting("adb_wifi_enabled", true, device, { verifyTimeoutMs: options.verifyTimeoutMs });
        enableError = undefined;
        break;
      } catch (e: any) {
        if (!(e instanceof TogglDevError) || e.kind !== "verify") throw e;
        enableError = e;
        await sleep(delayMs);
      }
    }
    if (enableError) throw enableError;
  }

  const warnings: string[] = [];
  let lastState = "";
  for (let i = 0; i < attempts; i++) {
    const info = await api.getWirelessDebugInfo(device);
    if (info?.ip && info?.port) {
      const { candidates, warnings: w } = chooseAdbPorts(info.ip, info.port, await mdnsServices());
      for (const message of w) if (!warnings.includes(message)) warnings.push(message);
      for (const { port, source } of candidates) {
        const serial = `${info.ip}:${port}`;
        const out = await runAdb(["connect", serial], 15000);
        if (!/^(already )?connected to/m.test(out.stdout)) continue;
        lastState = await deviceState(serial);
        if (lastState !== "device" && lastState !== "unauthorized") await runAdb(["disconnect", serial]); // stale entry
        if (lastState === "device") return { serial, ip: info.ip, port, source, warnings };
        if (lastState === "unauthorized") {
          await runAdb(["disconnect", serial]);
          throw new Error(
            `${serial} connected but adb reports it unauthorized: this computer's adb key is not accepted by the phone. Plug the phone in by USB once and accept the RSA prompt, or run 'adb pair <ip>:<pairing port> <code>' from the phone's Wireless debugging > Pair device screen.`
          );
        }
      }
    }
    if (i < attempts - 1) await sleep(delayMs);
  }

  if ((await api.getStatus(device)).adb_wifi_enabled !== true) {
    throw new Error("Wireless debugging did not stay on: Android reverted it. Check the phone for an approve-this-Wi-Fi prompt, then retry.");
  }
  if (/offline/i.test(lastState)) {
    throw new Error(
      "Wireless debugging is on and adb connected, but adb sees the phone as offline. The phone may be asleep or its wireless-debugging port may have just changed; retry in a moment."
    );
  }
  throw new Error(
    `Wireless debugging is on but 'adb connect' did not succeed${lastState ? ` (last state: ${lastState})` : ""}${warnings.length ? ` ${warnings.join(" ")}` : ""}. ` +
    "This computer's adb is probably not authorised for the phone: plug it in by USB once and accept the RSA prompt, or run 'adb pair' from the phone's Wireless debugging > Pair device screen."
  );
}

/** Drop the adb connection to the phone and turn wireless debugging off (for banking apps and the like). */
export async function disconnectAdb(device?: string) {
  const status = await api.getStatus(device);
  const disconnected: string[] = [];
  if (status.adb_wifi_enabled === true) {
    const info = await api.getWirelessDebugInfo(device);
    if (info?.ip) {
      const ports = new Set<number>(info.port ? [info.port] : []);
      for (const s of await mdnsServices()) if (s.service === CONNECT_SERVICE && s.host === info.ip) ports.add(s.port);
      for (const port of ports) {
        const serial = `${info.ip}:${port}`;
        const out = await runAdb(["disconnect", serial]);
        if (/disconnected/.test(out.stdout)) disconnected.push(serial);
      }
    }
  }
  const result = await api.toggleSetting("adb_wifi_enabled", false, device);
  return { disconnected, adb_wifi_enabled: false, verified: result.verified };
}
