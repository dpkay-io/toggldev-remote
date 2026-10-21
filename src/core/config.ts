import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface Config {
  host: string;
  port: number;
  token: string;
}

export function getConfigDir(): string {
  // TOGGLDEV_CONFIG_DIR selects a different paired device (one config per directory)
  return process.env.TOGGLDEV_CONFIG_DIR || path.join(os.homedir(), ".toggldev");
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

export function loadConfig(): Config {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    throw new Error("Not paired. Please pair with a device first.");
  }
  let config: Partial<Config>;
  try {
    config = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e: any) {
    throw new Error(`Cannot read ${p} (${e.message}). Pair again to recreate it.`);
  }
  if (!config.host || !config.port || !config.token) {
    throw new Error(`${p} is incomplete (needs host, port and token). Pair again to recreate it.`);
  }
  return config as Config;
}

// The file holds a bearer token that controls the phone, so keep it private to the user
// (no effect on Windows, where home directory ACLs already restrict other users).
export function saveConfig(config: Config) {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = getConfigPath();
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}
