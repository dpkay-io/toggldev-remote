#!/usr/bin/env node
import { Command } from "commander";
import { api } from "../core/api.js";
import { connectAdb, disconnectAdb } from "../core/adb.js";
import { parseBoolean, packageVersion, KNOWN_TOGGLE_KEYS, KNOWN_SET_KEYS } from "../core/util.js";

const program = new Command();

program
  .name("toggldev")
  .description("CLI to interact with TogglDev Android App remote access")
  .version(packageVersion())
  .option("-d, --device <name>", "Paired phone to use (see 'devices'); default is ~/.toggldev or $TOGGLDEV_DEVICE");

const device = (): string | undefined => program.opts().device;

/** Run a command: print its result as JSON, or the error message and exit 1. */
function run(fn: (options: any) => Promise<unknown>) {
  return async (options: any) => {
    try {
      const result = await fn(options);
      if (typeof result === "string") console.log(result);
      else if (result !== undefined) console.log(JSON.stringify(result, null, 2));
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
  };
}

program
  .command("discover")
  .description("Discover TogglDev devices on the local network")
  .option("-t, --timeout <seconds>", "Timeout for discovery in seconds", "5")
  .action(run(async (options) => ({ devices: await api.discoverDevices(Number(options.timeout)) })));

program
  .command("pair")
  .description("Pair with a TogglDev device (use --device <name> to keep several phones)")
  .requiredOption("--host <host>", "IP address of the device")
  .option("--port <port>", "Port of the device", "8734")
  .requiredOption("--code <code>", "Pairing code")
  .action(run((options) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port "${options.port}".`);
    return api.pairDevice(options.host, port, options.code, device());
  }));

program
  .command("devices")
  .description("List paired phones")
  .option("--check", "Also ask each phone for its status to see which are reachable")
  .action(run(async (options) => ({ devices: await api.listDevices(Boolean(options.check)) })));

program
  .command("relocate")
  .description("Find a paired phone again after its IP changed. Sends the saved token over plain HTTP to every TogglDev phone found on the network, so run it only on a network you trust.")
  .option("-t, --timeout <seconds>", "Timeout for discovery in seconds", "5")
  .action(run((options) => api.relocateDevice(device(), undefined, Number(options.timeout))));

program
  .command("status")
  .description("Get current developer settings status")
  .action(run(() => api.getStatus(device())));

program
  .command("toggle")
  .description(`Toggle a developer setting and confirm it took effect. Keys: ${KNOWN_TOGGLE_KEYS.join(", ")}`)
  .requiredOption("--key <key>", "Setting key to toggle")
  .requiredOption("--enabled <boolean>", "true or false")
  .option("--no-verify", "Don't read the status back; print the app's reply as earlier versions did")
  .action(run((options) => api.toggleSetting(options.key, parseBoolean(options.enabled), device(), { verify: options.verify })));

program
  .command("set")
  .description(`Set a specific value for a developer setting. Keys: ${KNOWN_SET_KEYS.join(", ")}`)
  .requiredOption("--key <key>", "Setting key to set")
  .requiredOption("--value <value>", "Value to set")
  .option("--no-verify", "Don't read the status back; print the app's reply as earlier versions did")
  .action(run((options) => api.setSetting(options.key, options.value, device(), { verify: options.verify })));

program
  .command("wireless-debug-info")
  .description("Get wireless debugging connection info as the app reports it (the port can be stale or wrong; prefer connect-adb)")
  .action(run(() => api.getWirelessDebugInfo(device())));

program
  .command("connect-adb")
  .description("Turn on wireless debugging if needed and 'adb connect'; prints the serial to use with 'adb -s'")
  .action(run(async () => {
    const result = await connectAdb(device());
    for (const warning of result.warnings) console.error(`warning: ${warning}`);
    return result;
  }));

program
  .command("disconnect-adb")
  .description("Disconnect adb and turn wireless debugging off")
  .action(run(() => disconnectAdb(device())));

program.parse(process.argv);
