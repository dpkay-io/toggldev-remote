import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface Config {
  host: string;
  port: number;
  token: string;
}

/** Name used for the config at ~/.toggldev/config.json when listing devices. */
export const DEFAULT_DEVICE = "default";

const DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Named devices live at <devicesRoot>/<name>/config.json. */
export function devicesRoot(): string {
  return process.env.TOGGLDEV_DEVICES_DIR || path.join(os.homedir(), ".toggldev", "devices");
}

export function validateDeviceName(name: string): string {
  // names become directory names, so they must not be able to escape the devices root
  if (!DEVICE_NAME.test(name)) {
    throw new Error(`Invalid device name "${name}". Use letters, digits, dot, dash or underscore.`);
  }
  return name;
}

/**
 * Which paired phone to use, in order: the `device` argument, TOGGLDEV_CONFIG_DIR (a directory),
 * TOGGLDEV_DEVICE (a name), then ~/.toggldev.
 */
export function getConfigDir(device?: string): string {
  const defaultDir = process.env.TOGGLDEV_CONFIG_DIR || path.join(os.homedir(), ".toggldev");
  const named = (name: string) => (name === DEFAULT_DEVICE ? defaultDir : path.join(devicesRoot(), validateDeviceName(name)));
  if (device) return named(device);
  if (process.env.TOGGLDEV_CONFIG_DIR) return process.env.TOGGLDEV_CONFIG_DIR;
  if (process.env.TOGGLDEV_DEVICE) return named(process.env.TOGGLDEV_DEVICE);
  return defaultDir;
}

export function getConfigPath(device?: string): string {
  return path.join(getConfigDir(device), "config.json");
}

/** The pairing used when no device is named: $TOGGLDEV_CONFIG_DIR/config.json, else ~/.toggldev/config.json. */
export function defaultConfigPath(): string {
  return path.join(process.env.TOGGLDEV_CONFIG_DIR || path.join(os.homedir(), ".toggldev"), "config.json");
}

/** Names of the phones paired under the devices root. */
export function listDeviceNames(): string[] {
  const root = devicesRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => n !== DEFAULT_DEVICE && DEVICE_NAME.test(n) && fs.existsSync(path.join(root, n, "config.json")))
    .sort();
}

export function readConfigFile(p: string): Config {
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

export function loadConfig(device?: string): Config {
  const p = getConfigPath(device);
  if (fs.existsSync(p)) return readConfigFile(p);

  const names = listDeviceNames();
  const list = names.length ? ` Paired devices: ${names.join(", ")}.` : "";
  if (device) {
    throw new Error(`No paired device named "${device}".${list} Pair it first.`);
  }
  // Nothing selected and no default pairing: use the only named device, never guess between several.
  const selected = process.env.TOGGLDEV_CONFIG_DIR || process.env.TOGGLDEV_DEVICE;
  if (!selected && names.length === 1) return readConfigFile(getConfigPath(names[0]));
  if (!selected && names.length > 1) {
    throw new Error(`Several devices are paired (${names.join(", ")}). Say which one to use.`);
  }
  throw new Error("Not paired. Please pair with a device first.");
}

// The file holds a bearer token that controls the phone, so keep it private to the user
// (no effect on Windows, where home directory ACLs already restrict other users).
export function saveConfig(config: Config, device?: string) {
  const dir = getConfigDir(device);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = getConfigPath(device);
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
