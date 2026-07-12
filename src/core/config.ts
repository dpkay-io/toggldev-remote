import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface Config {
  host: string;
  port: number;
  token: string;
}

export function getConfigPath(): string {
  // Use a custom directory for testing if environment variable is set
  if (process.env.TOGGLDEV_CONFIG_DIR) {
    const dir = process.env.TOGGLDEV_CONFIG_DIR;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, "config.json");
  }

  const home = os.homedir();
  const dir = path.join(home, ".toggldev");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, "config.json");
}

export function loadConfig(): Config {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    throw new Error("Not paired. Please pair with a device first.");
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function saveConfig(config: Config) {
  const p = getConfigPath();
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
}
