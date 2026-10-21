import { createRequire } from "node:module";

const TRUE_WORDS = ["true", "1", "yes", "on"];
const FALSE_WORDS = ["false", "0", "no", "off"];

/** Parse a user- or agent-supplied boolean. Throws on anything unrecognised instead of guessing false. */
export function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const word = String(value).trim().toLowerCase();
  if (TRUE_WORDS.includes(word)) return true;
  if (FALSE_WORDS.includes(word)) return false;
  throw new Error(`Invalid boolean "${value}". Use true or false.`);
}

/** Version from package.json (build/ and src/ both sit two levels below the package root). */
export function packageVersion(): string {
  const require = createRequire(import.meta.url);
  return require("../../package.json").version;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Toggle keys are the Android Settings names the app switches; /status reports four of them under
 * different names. Read from the app's source (v2.87); an unknown key is simply not verified.
 */
const TOGGLE_TO_STATUS_KEY: Record<string, string> = {
  development_settings_enabled: "developer_options_enabled",
  "debug.force_rtl": "force_rtl",
  enable_freeform_support: "freeform_windows",
  sysui_tuner_demo_on: "demo_mode"
};

const STATUS_TO_TOGGLE_KEY = Object.fromEntries(
  Object.entries(TOGGLE_TO_STATUS_KEY).map(([toggleKey, statusKey]) => [statusKey, toggleKey])
);

/** Accept the name /status uses for a setting as well as the name /toggle needs. */
export function toToggleKey(key: string): string {
  return STATUS_TO_TOGGLE_KEY[key] ?? key;
}

export function toStatusKey(toggleKey: string): string {
  return TOGGLE_TO_STATUS_KEY[toggleKey] ?? toggleKey;
}

/** Keys the app accepted when this was written (v2.87); newer app versions may accept more. */
export const KNOWN_TOGGLE_KEYS = [
  "development_settings_enabled", "adb_enabled", "adb_wifi_enabled", "stay_on_while_plugged_in",
  "always_finish_activities", "debug.force_rtl", "wait_for_debugger", "force_resizable_activities",
  "debug_view_attributes", "mobile_data_always_on", "enable_freeform_support", "sysui_tuner_demo_on"
];

export const KNOWN_SET_KEYS = [
  "window_animation_scale", "transition_animation_scale", "animator_duration_scale", "debug_app",
  "overlay_display_devices"
];
