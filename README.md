# Matterbridge No Longer Evil Thermostat Plugin

[![npm version](https://img.shields.io/npm/v/matterbridge-plugin-nolongerevil-thermostat.svg)](https://www.npmjs.com/package/matterbridge-plugin-nolongerevil-thermostat)
[![Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![ESM](https://img.shields.io/badge/ESM-Node.js-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![powered by](https://img.shields.io/badge/powered%20by-matterbridge-blue)](https://www.npmjs.com/package/matterbridge)

Bridges [No Longer Evil](https://nolongerevil.com) self-hosted Nest thermostats into [Matterbridge](https://github.com/Luligu/matterbridge), exposing each thermostat to Matter controllers (Apple Home, Google Home, SmartThings, Home Assistant, …) with sub-second live updates.

## What it does

For every thermostat reported by your No Longer Evil control server the plugin exposes:

- A **Thermostat** device with `LocalTemperature`, `OccupiedHeatingSetpoint`, `OccupiedCoolingSetpoint`, `SystemMode` (`Off` / `Heat` / `Cool` / `Auto`), and `ControlSequenceOfOperation` derived from each device's `can_heat` / `can_cool` capabilities.
- A separate on/off **Away** switch — `on` puts the thermostat in away mode, `off` returns to home.

State syncs both ways:

- Writes from a Matter controller (changing mode, setpoint, away) are translated into `POST /command` calls on the No Longer Evil control server.
- The No Longer Evil `GET /api/events` SSE stream drives near-instant updates back to Matter (the plugin re-fetches `/status?serial=…` on each event and pushes attribute updates).
- A defensive periodic poll (configurable, default 5 minutes) re-syncs every device to recover from any missed events or dropped streams.

## Requirements

- A running [No Longer Evil **self-hosted** control server](https://docs.nolongerevil.com/) (typically port `8082`).
- Matterbridge `>= 3.4.0`.
- Node.js `>= 20.19.0` (`>= 22.13.0` for the 22.x line, `>= 24.0.0` for the 24.x line).

> The plugin currently targets the **self-hosted** No Longer Evil control server. The hosted API at `nolongerevil.com/api/v1` is not yet supported because it does not expose the SSE event stream the plugin relies on for live updates.

## Install

```bash
npm install -g matterbridge-plugin-nolongerevil-thermostat
matterbridge -add matterbridge-plugin-nolongerevil-thermostat
```

Then open the Matterbridge frontend and configure the plugin (see below).

## Configuration

The plugin reads its config from Matterbridge's plugin settings UI (or `matterbridge-plugin-nolongerevil-thermostat.config.json`):

| Field                  | Type     | Default                 | Description                                                                                                      |
| ---------------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apiUrl`               | string   | `http://localhost:8082` | Base URL of the No Longer Evil self-hosted control server. No trailing slash needed.                             |
| `pollIntervalSeconds`  | integer  | `300`                   | Defensive periodic re-sync. Live updates use SSE; this poll catches anything the stream missed. `0` disables it. |
| `whiteList`            | string[] | `[]`                    | Only thermostats whose name or serial appears here will be exposed. Empty = all.                                 |
| `blackList`            | string[] | `[]`                    | Thermostats whose name or serial appears here are excluded.                                                      |
| `debug`                | boolean  | `false`                 | Verbose plugin logging.                                                                                          |
| `unregisterOnShutdown` | boolean  | `false`                 | Unregister all devices on shutdown — useful during development.                                                  |

### Security note

The No Longer Evil self-hosted control server has **no authentication by default**. If you expose it outside your trusted LAN, put it behind a reverse proxy with proper auth before pointing this plugin at it.

## Mode mapping

| No Longer Evil mode | Matter `SystemMode` |
| ------------------- | ------------------- |
| `off`               | `Off` (0)           |
| `heat`              | `Heat` (4)          |
| `cool`              | `Cool` (3)          |
| `range`             | `Auto` (1)          |
| `emergency`         | `EmergencyHeat` (5) |

In `range`/Auto mode the plugin uses the `target_temperature_low` / `target_temperature_high` fields and writes both bounds when either setpoint is changed from a Matter controller.

## Out of scope (for now)

The first release deliberately keeps the surface small. The following are not exposed yet but the codebase has clean seams for adding them:

- Fan control (`set_fan` / Matter `FanControl` cluster)
- Humidity reporting
- Schedule editing
- Setting `EmergencyHeat` from a Matter controller (it's read-back only)

## Troubleshooting

### "SSE event stream reconnecting after: terminated" every 30–60 s

This is expected behavior with some servers and reverse proxies — the SSE connection gets closed when idle, the plugin reconnects automatically, and no events are lost outside a sub-second gap. The `info`-level log entry is intentionally visible so you can confirm the loop is healthy.

### Plugin shows the away switch but no thermostat

Make sure you're running v1.0.0 or later — earlier dev builds had a unit-encoding bug that caused thermostat registration to fail silently.

### Two devices with the same name

You may have stale registrations from a prior run. Either:

- Set `unregisterOnShutdown: true`, restart matterbridge, then turn it back off; or
- `matterbridge -remove .` then `matterbridge -add .`.

## Development

```bash
npm install
npm run build
npm run test            # Jest, must hit 100% coverage on lines + functions
npm run test:vitest     # Vitest mirror
npm run lint
npm run format:check
```

To run against a local Matterbridge:

```bash
npm run dev:link        # links the global matterbridge package
npm run matterbridge:add
matterbridge
```

## License

[Apache 2.0](LICENSE).

This plugin is built on the excellent [matterbridge-plugin-template](https://github.com/Luligu/matterbridge-plugin-template) by Luca Liguori.
