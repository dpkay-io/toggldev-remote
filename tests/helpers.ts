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
