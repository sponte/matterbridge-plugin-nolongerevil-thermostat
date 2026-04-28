# Matterbridge No Longer Evil Thermostat Plugin — Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-04-28

### Added

- Initial release of the plugin.
- Discovers thermostats via `GET /api/devices` on the No Longer Evil self-hosted control server.
- Per-device Matter endpoints:
  - **Thermostat** with `LocalTemperature`, `OccupiedHeatingSetpoint`, `OccupiedCoolingSetpoint`, `SystemMode`, and `ControlSequenceOfOperation`.
  - **Away** on/off switch.
- Bi-directional sync:
  - Matter writes for `SystemMode` and setpoints translate to `POST /command` (`set_mode`, `set_temperature` — single value or `{high, low}` for range mode).
  - Matter `on`/`off` on the away switch translate to `set_away`.
  - SSE subscription on `GET /api/events` re-fetches `/status?serial=…` on each notification and pushes attribute updates back into Matter.
- Defensive periodic poll (configurable, default 5 minutes) re-syncs every device against `/status` to recover from missed events.
- SSE reconnect with exponential backoff (1s → 30s) on errors.
- Configuration: `apiUrl`, `pollIntervalSeconds`, `whiteList`, `blackList`, `debug`, `unregisterOnShutdown`.
- 100% line + function coverage on Jest; mirrored Vitest suite.

### Notes

- This release deliberately scopes to **mode + setpoints + temperature + away** for Nest Gen2-class devices. Fan control, humidity reporting, schedule editing, and setting `EmergencyHeat` from Matter are out of scope and tracked for a follow-up.
- Targets the **self-hosted** control server. The hosted `nolongerevil.com/api/v1` API is not yet supported because it does not expose the SSE event stream the plugin relies on.
