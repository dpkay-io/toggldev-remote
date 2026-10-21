import http from "node:http";
import { AddressInfo } from "node:net";

export type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

export interface RecordedRequest {
  method?: string;
  url?: string;
  auth?: string;
  body: string;
}

/** A fake TogglDev phone: records requests and answers with whatever the test supplies. */
export async function fakePhone(handler: Handler) {
  const requests: RecordedRequest[] = [];
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

export const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * A phone that remembers settings. `apply` decides what a toggle/set does to the stored value
 * (default: stores it), so tests can model a phone that reverts or lags.
 */
export async function statefulPhone(initial: Record<string, any>, options: {
  token?: string;
  apply?: (key: string, value: any, state: Record<string, any>) => void;
  wirelessDebug?: (state: Record<string, any>) => unknown;
} = {}) {
  const state = { ...initial };
  const token = options.token ?? "t";
  const phone = await fakePhone((req, body, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: "Invalid token" });
    if (req.method === "GET" && req.url === "/status") return json(res, 200, state);
    if (req.method === "GET" && req.url === "/wireless-debug-info") {
      return json(res, 200, options.wirelessDebug ? options.wirelessDebug(state) : { enabled: false });
    }
    const m = req.url?.match(/^\/(toggle|set)\/(.+)$/);
    if (req.method === "POST" && m) {
      const key = decodeURIComponent(m[2]);
      const parsed = JSON.parse(body);
      const value = m[1] === "toggle" ? parsed.enabled : parsed.value;
      (options.apply ?? ((k, v, s) => { s[k] = v; }))(key, value, state);
      return json(res, 200, { ok: true, key });
    }
    json(res, 404, { error: "not found" });
  });
  return { ...phone, state };
}

export interface Fixture {
  app_version: string;
  captured: string;
  status: Record<string, any>;
  wireless_debug_info: Record<string, any>;
  errors: Record<string, { status: number; body: any }>;
}

// How the released app maps /toggle keys to the /status keys it reports and the values it stores.
// Written out here from the app's source (v2.87), independently of the client's own table.
const APP_TOGGLES: Record<string, { status: string; on: any; off: any }> = {
  development_settings_enabled: { status: "developer_options_enabled", on: true, off: false },
  adb_enabled: { status: "adb_enabled", on: true, off: false },
  adb_wifi_enabled: { status: "adb_wifi_enabled", on: true, off: false },
  stay_on_while_plugged_in: { status: "stay_on_while_plugged_in", on: 3, off: 0 },
  always_finish_activities: { status: "always_finish_activities", on: true, off: false },
  "debug.force_rtl": { status: "force_rtl", on: true, off: false },
  wait_for_debugger: { status: "wait_for_debugger", on: true, off: false },
  force_resizable_activities: { status: "force_resizable_activities", on: true, off: false },
  debug_view_attributes: { status: "debug_view_attributes", on: true, off: false },
  mobile_data_always_on: { status: "mobile_data_always_on", on: true, off: false },
  enable_freeform_support: { status: "freeform_windows", on: true, off: false },
  sysui_tuner_demo_on: { status: "demo_mode", on: true, off: false }
};
const APP_SET_KEYS = new Set([
  "window_animation_scale", "transition_animation_scale", "animator_duration_scale", "debug_app", "overlay_display_devices"
]);

/** A phone that replays a captured fixture: its status, its error bodies, and the app's toggle/set rules. */
export async function fixturePhone(fixture: Fixture, token = "t") {
  const state = structuredClone(fixture.status);
  const phone = await fakePhone((req, body, res) => {
    const bad = fixture.errors.bad_token;
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, bad.status, bad.body);
    if (req.method === "GET" && req.url === "/status") return json(res, 200, state);
    if (req.method === "GET" && req.url === "/wireless-debug-info") return json(res, 200, fixture.wireless_debug_info);
    const m = req.url?.match(/^\/(toggle|set)\/(.+)$/);
    if (req.method === "POST" && m) {
      const key = decodeURIComponent(m[2]);
      const parsed = JSON.parse(body);
      if (m[1] === "toggle" && APP_TOGGLES[key]) {
        if (!("enabled" in parsed)) return json(res, fixture.errors.missing_enabled.status, fixture.errors.missing_enabled.body);
        const t = APP_TOGGLES[key];
        state[t.status] = parsed.enabled ? t.on : t.off;
        return json(res, 200, { ok: true, key, enabled: parsed.enabled });
      }
      if (m[1] === "set" && APP_SET_KEYS.has(key)) {
        state[key] = parsed.value;
        return json(res, 200, { ok: true, key });
      }
      const unknown = fixture.errors.unknown_key;
      return json(res, unknown.status, { error: `Unknown key: ${key}` });
    }
    json(res, 404, { error: "not found" });
  });
  return { ...phone, state };
}
