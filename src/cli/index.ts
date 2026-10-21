#!/usr/bin/env node
import { Command } from "commander";
import { api } from "../core/api.js";
import { parseBoolean, packageVersion } from "../core/util.js";

const program = new Command();

program
  .name("toggldev")
  .description("CLI to interact with TogglDev Android App remote access")
  .version(packageVersion());

program
  .command("discover")
  .description("Discover TogglDev devices on the local network")
  .option("-t, --timeout <seconds>", "Timeout for discovery in seconds", "5")
  .action(async (options) => {
    try {
      const devices = await api.discoverDevices(Number(options.timeout));
      console.log(JSON.stringify({ devices }, null, 2));
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
  });

program
  .command("pair")
  .description("Pair with a TogglDev device")
  .requiredOption("--host <host>", "IP address of the device")
  .requiredOption("--port <port>", "Port of the device")
  .requiredOption("--code <code>", "Pairing code")
  .action(async (options) => {
    try {
      const result = await api.pairDevice(options.host, Number(options.port), options.code);
      console.log(result);
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Get current developer settings status")
  .action(async () => {
    try {
      const status = await api.getStatus();
      console.log(JSON.stringify(status, null, 2));
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
  });

program
  .command("toggle")
  .description("Toggle a developer setting")
  .requiredOption("--key <key>", "Setting key to toggle")
  .requiredOption("--enabled <boolean>", "true or false")
  .action(async (options) => {
    try {
      const enabled = parseBoolean(options.enabled);
      const result = await api.toggleSetting(options.key, enabled);
      console.log(JSON.stringify(result, null, 2));
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
  });

program
  .command("set")
  .description("Set a specific value for a developer setting")
  .requiredOption("--key <key>", "Setting key to set")
  .requiredOption("--value <value>", "Value to set")
  .action(async (options) => {
    try {
      const result = await api.setSetting(options.key, options.value);
      console.log(JSON.stringify(result, null, 2));
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
  });

program
  .command("wireless-debug-info")
  .description("Get wireless debugging connection info")
  .action(async () => {
    try {
      const info = await api.getWirelessDebugInfo();
      console.log(JSON.stringify(info, null, 2));
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
  });

program.parse(process.argv);
