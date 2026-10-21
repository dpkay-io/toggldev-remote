#!/usr/bin/env node
// Save a phone's real responses as a test fixture (run after `npm run build`).
//   node scripts/capture-fixtures.mjs <device> --app-version 2.94 [--out tests/fixtures]
// Only reads, plus two requests the app rejects (unknown key, missing field). The pairing token is
// never written; private IPs are replaced with documentation addresses (192.0.2.x).
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../build/core/config.js";

const args = process.argv.slice(2);
const device = args[0];
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const appVersion = opt("--app-version");
const outDir = opt("--out") ?? "tests/fixtures";
if (!device || device.startsWith("-") || !appVersion) {
  console.error("usage: capture-fixtures.mjs <device> --app-version <x.y> [--out dir]");
  process.exit(2);
}

const config = loadConfig(device);
const base = `http://${config.host}:${config.port}`;

async function call(method, urlPath, { token = config.token, body } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000)
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed };
}

const ok = async (urlPath) => {
  const r = await call("GET", urlPath);
  if (r.status !== 200) throw new Error(`${urlPath}: HTTP ${r.status}`);
  return r.body;
};

const fixture = {
  app_version: appVersion,
  captured: new Date().toISOString().slice(0, 10),
  status: await ok("/status"),
  wireless_debug_info: await ok("/wireless-debug-info"),
  errors: {
    bad_token: await call("GET", "/status", { token: "not-a-token" }),
    unknown_key: await call("POST", "/toggle/not_a_key", { body: { enabled: true } }),
    missing_enabled: await call("POST", "/toggle/adb_wifi_enabled", { body: {} })
  }
};

// stable fake addresses, in order of first appearance
const fakeIps = new Map();
const sanitized = JSON.parse(
  JSON.stringify(fixture).replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (ip) => {
    if (!fakeIps.has(ip)) fakeIps.set(ip, `192.0.2.${10 + fakeIps.size}`);
    return fakeIps.get(ip);
  })
);
if (JSON.stringify(sanitized).includes(config.token)) throw new Error("token found in fixture; refusing to write");

fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `app-${appVersion}-${device}.json`);
fs.writeFileSync(file, JSON.stringify(sanitized, null, 2) + "\n");
console.log(`wrote ${file}`);
