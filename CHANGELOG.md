# Changelog

## 1.1.0

### Added
- Several phones: `--device <name>` (`-d`) on every command, `toggldev devices [--check]`, and a `device` argument on every MCP tool. Named pairings live in `~/.toggldev/devices/<name>/`.
- `connect-adb` / `disconnect-adb` (CLI and MCP `connect_adb` / `disconnect_adb`): turn wireless debugging on if needed and run `adb connect` on the right port. The port the app reports can belong to another phone, so the port adb itself lists for the phone's IP is preferred.
- `relocate`: find a paired phone again after its IP changed (opt-in; offers the saved token to TogglDev phones on the network).
- MCP `list_devices`.
- Test fixtures captured from TogglDev app 2.87 and 2.94, and `npm run live` to check a build against real phones.

### Changed (behaviour you may notice)
- `toggle` and `set` now read the phone's status afterwards. The result gains `verified` and `actual`; if the value did not change, the command exits 1 (the app replies "ok" even when Android reverts a change). `--no-verify` or `TOGGLDEV_VERIFY=0` restores the previous behaviour.
- `toggle --enabled` accepts true/false/1/0/yes/no/on/off in any case and rejects anything else. Before, only the exact text `true` meant on; `True`, `1` and `yes` silently meant off.
- Requests time out after 8 seconds instead of hanging (`TOGGLDEV_TIMEOUT_MS` to change). Error messages say what to check; the 401 message still starts with the previous sentence.
- The config file is written mode 0600 (directory 0700). Existing files keep their mode until re-saved; run `chmod 600 ~/.toggldev/config.json` to tighten one now. Reading no longer creates `~/.toggldev`.
- `discover` reports each phone once.
- `pair --port` defaults to 8734; `--version` reports the real version (it said 1.0.0).
- For `toggle`, the names `/status` uses for four settings (`developer_options_enabled`, `force_rtl`, `freeform_windows`, `demo_mode`) are accepted as well as the Android setting names.

### Fixed
- The README and MCP instructions listed `show_touches` as a toggle key; the app rejects it. Valid keys are now listed.
- Regenerated `package-lock.json` (the committed one did not match `package.json`).
- Added a `LICENSE` file matching `UNLICENSED`.
