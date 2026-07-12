import { Bonjour } from "bonjour-service";
import { loadConfig, saveConfig, Config } from "./config.js";

export interface DeviceInfo {
  host: string;
  port: number;
}

export class TogglDevAPI {
  async apiRequest(config: Config, method: string, urlPath: string, body?: any) {
    const url = `http://${config.host}:${config.port}${urlPath}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${config.token}`
    };
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    if (response.status === 401) {
      throw new Error("Authentication failed. Token is invalid or expired. Please pair again.");
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
    const response = await fetch(`http://${host}:${port}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    const text = await response.text();
    
    if (!response.ok) {
      throw new Error(`Pairing failed: ${response.status} ${text}`);
    }

    const data = JSON.parse(text);
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
