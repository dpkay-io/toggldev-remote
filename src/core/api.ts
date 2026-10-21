import { Bonjour } from "bonjour-service";
import { loadConfig, saveConfig, Config } from "./config.js";

export interface DeviceInfo {
  host: string;
  port: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

function requestTimeoutMs(): number {
  const fromEnv = Number(process.env.TOGGLDEV_TIMEOUT_MS);
  return fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
}

/** Turn a low-level fetch failure into a message that says what to check. */
function describeNetworkError(host: string, port: number, err: any, timeoutMs: number): Error {
  const target = `${host}:${port}`;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new Error(
      `No response from ${target} within ${timeoutMs / 1000}s. The phone may be asleep or on a different network, or the TogglDev remote access server may be stopped.`
    );
  }
  const code = err?.cause?.code ?? err?.code;
  if (code === "ECONNREFUSED") {
    return new Error(
      `Connection refused by ${target}. The phone is reachable but TogglDev's remote access server is not running; open the app and start it.`
    );
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new Error(
      `Cannot reach ${target} (${code}). Check the phone is on the same network (or use its Tailscale IP); a DHCP lease may have changed its address.`
    );
  }
  return new Error(`Request to ${target} failed: ${err?.cause?.message ?? err?.message ?? err}`);
}

function retryAfterSuffix(text: string): string {
  try {
    const seconds = JSON.parse(text).retry_after_seconds;
    if (typeof seconds === "number") return ` Try again in about ${Math.ceil(seconds)}s.`;
  } catch (e) {}
  return "";
}

export class TogglDevAPI {
  /** fetch with a timeout and readable network errors. */
  private async send(host: string, port: number, urlPath: string, init: RequestInit) {
    const timeoutMs = requestTimeoutMs();
    try {
      return await fetch(`http://${host}:${port}${urlPath}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err: any) {
      throw describeNetworkError(host, port, err, timeoutMs);
    }
  }

  async apiRequest(config: Config, method: string, urlPath: string, body?: any) {
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
    });

    if (response.status === 401) {
      throw new Error(
        `Authentication failed for ${config.host}. A phone keeps only one pairing token, so this usually means it was paired again from another machine (or its pairing was reset). Pair again with a new code.`
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${text}`);
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      return text;
    }
  }

  async discoverDevices(timeoutSeconds = 5): Promise<DeviceInfo[]> {
    const bonjour = new Bonjour();
    const devices: DeviceInfo[] = [];

    const browser = bonjour.find({ type: "toggldev" }, (service: any) => {
      const ipv4 = service.addresses?.find((a: string) => !a.includes(":"));
      const host = ipv4 || service.addresses?.[0] || service.host;
      devices.push({
        host,
        port: service.port
      });
    });

    await new Promise(resolve => setTimeout(resolve, timeoutSeconds * 1000));
    browser.stop();
    bonjour.destroy();

    return devices;
  }

  async pairDevice(host: string, port: number, code: string): Promise<string> {
    const response = await this.send(host, port, "/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    const text = await response.text();

    if (response.status === 429) {
      throw new Error(`Pairing refused: too many attempts.${retryAfterSuffix(text)} Not retrying, so the lockout is not extended.`);
    }
    if (!response.ok) {
      throw new Error(`Pairing failed: ${response.status} ${text}`);
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

    saveConfig({ host, port, token: data.token });
    return "Paired successfully. Configuration saved.";
  }

  async getStatus() {
    const config = loadConfig();
    return this.apiRequest(config, "GET", "/status");
  }

  async toggleSetting(key: string, enabled: boolean) {
    const config = loadConfig();
    return this.apiRequest(config, "POST", `/toggle/${key}`, { enabled });
  }

  async setSetting(key: string, value: string) {
    const config = loadConfig();
    let parsedValue: any = value;
    try { parsedValue = JSON.parse(value); } catch (e) {}
    return this.apiRequest(config, "POST", `/set/${key}`, { value: parsedValue });
  }

  async getWirelessDebugInfo() {
    const config = loadConfig();
    return this.apiRequest(config, "GET", "/wireless-debug-info");
  }
}

export const api = new TogglDevAPI();
