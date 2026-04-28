/**
 * Matterbridge plugin entry point bridging No Longer Evil thermostats from a self-hosted control server.
 *
 * Each remote thermostat is exposed as two bridged endpoints:
 *  - a Thermostat device (LocalTemperature, OccupiedHeating/CoolingSetpoint, SystemMode, ControlSequenceOfOperation)
 *  - an On/Off Plug-in Unit acting as the away toggle ("<name> Away")
 *
 * Live updates use the server's SSE endpoint /api/events; a defensive periodic poll re-syncs state on a
 * configurable interval to recover from missed events.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { bridgedNode, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, onOffOutlet, PlatformConfig, PlatformMatterbridge, thermostatDevice } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import {
  clampSetpointC,
  controlSequenceFor,
  cToMatter,
  extractSetpoints,
  matterToC,
  NLE_MAX_C,
  NLE_MIN_C,
  nleModeToSystemMode,
  NleStatus,
  SystemMode,
  systemModeToNleCommand,
} from './matter-mapping.js';
import { getStatus, listDevices, sendCommand, subscribeEvents } from './nle-client.js';

const VENDOR_ID = 0xfff1;
const VENDOR_NAME = 'Matterbridge';
const PRODUCT_NAME = 'No Longer Evil Thermostat';

interface ThermostatBinding {
  serial: string;
  thermostat: MatterbridgeEndpoint;
  away: MatterbridgeEndpoint;
  /** Suppresses echo of NLE-driven attribute updates back to the API. */
  syncing: boolean;
  /** Last mode received from /status; needed to choose set_temperature shape. */
  currentMode: NleStatus['mode'];
}

/**
 * Standard Matterbridge plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge Matterbridge runtime instance.
 * @param {AnsiLogger} log Plugin logger provided by Matterbridge.
 * @param {PlatformConfig} config Configuration object loaded from the plugin config file.
 * @returns {NoLongerEvilThermostatPlatform} The platform instance Matterbridge will manage.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): NoLongerEvilThermostatPlatform {
  return new NoLongerEvilThermostatPlatform(matterbridge, log, config);
}

/**
 * DynamicPlatform plugin that bridges every No Longer Evil thermostat reachable on the configured
 * self-hosted control server.
 */
export class NoLongerEvilThermostatPlatform extends MatterbridgeDynamicPlatform {
  private readonly bindings = new Map<string, ThermostatBinding>();
  private sseAbort: AbortController | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  /**
   * Construct the platform and verify that the host Matterbridge satisfies the minimum version.
   *
   * @param {PlatformMatterbridge} matterbridge Matterbridge runtime.
   * @param {AnsiLogger} log Plugin logger.
   * @param {PlatformConfig} config Plugin configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info('Initializing NoLongerEvilThermostatPlatform');
  }

  /**
   * Lifecycle hook: discover thermostats, register them, and open the SSE subscription.
   *
   * @param {string} [reason] Reason supplied by Matterbridge.
   * @returns {Promise<void>} Resolves when discovery completes (SSE keeps running in the background).
   */
  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);

    await this.ready;
    await this.clearSelect();

    await this.discoverDevices();
    this.startSseSubscription();
    this.startDefensivePoll();
  }

  /**
   * Lifecycle hook: configure registered devices.
   *
   * @returns {Promise<void>} Resolves once configuration finishes.
   */
  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    for (const device of this.getDevices()) {
      this.log.info(`Configuring device ${device.deviceName} with id ${device.originalId}`);
    }
  }

  /**
   * Lifecycle hook: react to a logger level change.
   *
   * @param {LogLevel} logLevel New log level requested by Matterbridge.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  /**
   * Lifecycle hook: stop the SSE subscription, clear the poll timer, and optionally unregister devices.
   *
   * @param {string} [reason] Reason supplied by Matterbridge.
   * @returns {Promise<void>} Resolves once shutdown work completes.
   */
  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);

    if (this.sseAbort) {
      this.sseAbort.abort();
      this.sseAbort = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Discover every thermostat reported by the control server and register a Matter endpoint pair for each.
   *
   * @returns {Promise<void>} Resolves once all reachable devices have been registered.
   */
  private async discoverDevices(): Promise<void> {
    const apiUrl = this.getApiUrl();
    this.log.info(`Discovering No Longer Evil thermostats from ${apiUrl}`);

    let devices;
    try {
      devices = await listDevices(apiUrl);
    } catch (error) {
      this.log.error(`Failed to list devices from ${apiUrl}: ${(error as Error).message}`);
      return;
    }
    this.log.info(`Discovered ${devices.length} thermostat(s)`);

    for (const device of devices) {
      const displayName = device.name ?? device.serial;
      this.setSelectDevice(device.serial, displayName);
      if (!this.validateDevice([displayName, device.serial])) {
        this.log.debug(`Skipping ${displayName} (${device.serial}) — excluded by white/black list`);
        continue;
      }

      let status: NleStatus;
      try {
        status = await getStatus(apiUrl, device.serial);
      } catch (error) {
        this.log.error(`Failed to fetch status for ${displayName} (${device.serial}): ${(error as Error).message}`);
        continue;
      }

      let binding: ThermostatBinding;
      try {
        binding = this.createBinding(device.serial, displayName, status);
      } catch (error) {
        this.log.error(`Failed to build endpoints for ${displayName} (${device.serial}): ${(error as Error).message}`);
        continue;
      }
      this.bindings.set(device.serial, binding);
      try {
        await this.registerDevice(binding.thermostat);
        await this.registerDevice(binding.away);
        await this.applyStatusToBinding(binding, status);
      } catch (error) {
        this.log.error(`Failed to register ${displayName} (${device.serial}): ${(error as Error).message}`);
        this.bindings.delete(device.serial);
      }
    }
  }

  /**
   * Build a thermostat + away-switch endpoint pair and wire their command handlers.
   *
   * @param {string} serial Device serial number.
   * @param {string} displayName Human-readable name.
   * @param {NleStatus} status Current status used to seed the cluster servers.
   * @returns {ThermostatBinding} The constructed binding (not yet registered).
   */
  private createBinding(serial: string, displayName: string, status: NleStatus): ThermostatBinding {
    const setpoints = extractSetpoints(status);
    const localTempC = Number.isFinite(status.current_temperature ?? NaN) ? (status.current_temperature as number) : setpoints.heat;

    // Note: createDefaultThermostatClusterServer expects raw degrees Celsius — it multiplies by 100 internally.
    const thermostat = new MatterbridgeEndpoint([thermostatDevice, bridgedNode], { id: `nle-thermo-${serial}` }, Boolean(this.config.debug))
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serial, VENDOR_ID, VENDOR_NAME, PRODUCT_NAME)
      .createDefaultThermostatClusterServer(localTempC, setpoints.heat, setpoints.cool, 0.5, NLE_MIN_C, NLE_MAX_C, NLE_MIN_C, NLE_MAX_C)
      .addRequiredClusterServers();

    const away = new MatterbridgeEndpoint([onOffOutlet, bridgedNode], { id: `nle-away-${serial}` }, Boolean(this.config.debug))
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(`${displayName} Away`, `${serial}-away`, VENDOR_ID, VENDOR_NAME, `${PRODUCT_NAME} (Away)`)
      .createDefaultOnOffClusterServer(Boolean(status.away))
      .addRequiredClusterServers();

    const binding: ThermostatBinding = { serial, thermostat, away, syncing: false, currentMode: status.mode };

    away.addCommandHandler('on', () => {
      void this.handleAwayCommand(binding, true);
    });
    away.addCommandHandler('off', () => {
      void this.handleAwayCommand(binding, false);
    });

    void thermostat.subscribeAttribute('Thermostat', 'systemMode', (newValue) => {
      void this.handleSystemModeWrite(binding, Number(newValue));
    });
    void thermostat.subscribeAttribute('Thermostat', 'occupiedHeatingSetpoint', (newValue) => {
      void this.handleSetpointWrite(binding, 'heat', Number(newValue));
    });
    void thermostat.subscribeAttribute('Thermostat', 'occupiedCoolingSetpoint', (newValue) => {
      void this.handleSetpointWrite(binding, 'cool', Number(newValue));
    });

    return binding;
  }

  /**
   * Push every changeable Matter attribute on a binding to mirror the given /status payload.
   *
   * @param {ThermostatBinding} binding Endpoint pair to update.
   * @param {NleStatus} status Latest status from the No Longer Evil API.
   * @returns {Promise<void>} Resolves once all attribute writes complete.
   */
  private async applyStatusToBinding(binding: ThermostatBinding, status: NleStatus): Promise<void> {
    binding.currentMode = status.mode;
    binding.syncing = true;
    try {
      const setpoints = extractSetpoints(status);
      const localTemp = cToMatter(status.current_temperature);
      if (localTemp !== null) await binding.thermostat.updateAttribute('Thermostat', 'localTemperature', localTemp);
      const heat = cToMatter(setpoints.heat);
      if (heat !== null) await binding.thermostat.updateAttribute('Thermostat', 'occupiedHeatingSetpoint', heat);
      const cool = cToMatter(setpoints.cool);
      if (cool !== null) await binding.thermostat.updateAttribute('Thermostat', 'occupiedCoolingSetpoint', cool);
      await binding.thermostat.updateAttribute('Thermostat', 'systemMode', nleModeToSystemMode(status.mode));
      await binding.thermostat.updateAttribute('Thermostat', 'controlSequenceOfOperation', controlSequenceFor(status.can_heat, status.can_cool));
      await binding.away.updateAttribute('OnOff', 'onOff', Boolean(status.away));
    } finally {
      binding.syncing = false;
    }
  }

  /**
   * Translate a Matter SystemMode write into an NLE set_mode command.
   *
   * @param {ThermostatBinding} binding Affected device binding.
   * @param {number} systemMode New SystemMode enum value.
   * @returns {Promise<void>} Resolves once the command is dispatched.
   */
  private async handleSystemModeWrite(binding: ThermostatBinding, systemMode: number): Promise<void> {
    if (binding.syncing) return;
    const value = systemModeToNleCommand(systemMode);
    this.log.info(`SystemMode write on ${binding.serial}: ${systemMode} -> set_mode ${value}`);
    try {
      await sendCommand(this.getApiUrl(), binding.serial, { command: 'set_mode', value });
    } catch (error) {
      this.log.error(`set_mode failed for ${binding.serial}: ${(error as Error).message}`);
    }
  }

  /**
   * Translate a Matter setpoint write into an NLE set_temperature command.
   *
   * Auto/range mode requires a single command carrying both bounds, so reads of the sibling
   * setpoint are pulled from the cluster's persisted state.
   *
   * @param {ThermostatBinding} binding Affected device binding.
   * @param {"heat" | "cool"} which Which setpoint Matter wrote.
   * @param {number} matterValue Encoded value (Celsius * 100).
   * @returns {Promise<void>} Resolves once the command is dispatched.
   */
  private async handleSetpointWrite(binding: ThermostatBinding, which: 'heat' | 'cool', matterValue: number): Promise<void> {
    if (binding.syncing) return;
    const requestedC = clampSetpointC(matterToC(matterValue));
    const apiUrl = this.getApiUrl();

    if (binding.currentMode === 'range') {
      const otherAttr = which === 'heat' ? 'occupiedCoolingSetpoint' : 'occupiedHeatingSetpoint';
      const otherRaw = binding.thermostat.getAttribute('Thermostat', otherAttr);
      const otherC = clampSetpointC(typeof otherRaw === 'number' ? matterToC(otherRaw) : NLE_MAX_C);
      const high = which === 'cool' ? requestedC : otherC;
      const low = which === 'heat' ? requestedC : otherC;
      this.log.info(`Setpoint range write on ${binding.serial}: high=${high} low=${low}`);
      try {
        await sendCommand(apiUrl, binding.serial, { command: 'set_temperature', value: { high, low } });
      } catch (error) {
        this.log.error(`set_temperature (range) failed for ${binding.serial}: ${(error as Error).message}`);
      }
      return;
    }

    if ((which === 'heat' && binding.currentMode !== 'heat' && binding.currentMode !== 'emergency') || (which === 'cool' && binding.currentMode !== 'cool')) {
      this.log.debug(`Ignoring ${which} setpoint write on ${binding.serial} — current mode is ${binding.currentMode ?? 'unknown'}`);
      return;
    }

    this.log.info(`Setpoint write on ${binding.serial}: ${which}=${requestedC}`);
    try {
      await sendCommand(apiUrl, binding.serial, { command: 'set_temperature', value: requestedC });
    } catch (error) {
      this.log.error(`set_temperature failed for ${binding.serial}: ${(error as Error).message}`);
    }
  }

  /**
   * Translate an away-switch on/off command into an NLE set_away command.
   *
   * @param {ThermostatBinding} binding Affected device binding.
   * @param {boolean} away Desired away state.
   * @returns {Promise<void>} Resolves once the command is dispatched.
   */
  private async handleAwayCommand(binding: ThermostatBinding, away: boolean): Promise<void> {
    this.log.info(`Away command on ${binding.serial}: ${away}`);
    try {
      await sendCommand(this.getApiUrl(), binding.serial, { command: 'set_away', value: away });
    } catch (error) {
      this.log.error(`set_away failed for ${binding.serial}: ${(error as Error).message}`);
    }
  }

  /**
   * Open the long-running SSE subscription. Calls applyStatusToBinding for every event whose serial
   * matches a registered binding.
   */
  private startSseSubscription(): void {
    if (this.bindings.size === 0) return;
    const apiUrl = this.getApiUrl();
    this.sseAbort = new AbortController();
    void subscribeEvents(apiUrl, this.sseAbort.signal, {
      onSerial: (serial) => {
        void this.handleEvent(serial);
      },
      onConnect: () => {
        this.log.info(`SSE event stream connected at ${apiUrl}/api/events`);
      },
      onDisconnect: () => {
        this.log.info('SSE event stream closed by server; reconnecting');
      },
      onError: (error) => {
        this.log.info(`SSE event stream reconnecting after: ${(error as Error).message ?? String(error)}`);
      },
    });
  }

  /**
   * Re-fetch /status for one device and push the result into its Matter binding.
   *
   * @param {string} serial Device serial reported by the SSE stream.
   * @returns {Promise<void>} Resolves once the binding is updated.
   */
  private async handleEvent(serial: string): Promise<void> {
    const binding = this.bindings.get(serial);
    if (!binding) return;
    try {
      const status = await getStatus(this.getApiUrl(), serial);
      this.log.debug(`SSE update for ${serial}: mode=${status.mode ?? 'null'} away=${status.away ?? false}`);
      await this.applyStatusToBinding(binding, status);
    } catch (error) {
      this.log.warn(`Failed to apply event for ${serial}: ${(error as Error).message}`);
    }
  }

  /**
   * Schedule a periodic re-sync that re-reads /status for every binding. Defends against missed SSE events.
   */
  private startDefensivePoll(): void {
    const intervalRaw = Number(this.config.pollIntervalSeconds);
    if (!Number.isFinite(intervalRaw) || intervalRaw <= 0 || this.bindings.size === 0) return;
    const intervalMs = Math.max(30, intervalRaw) * 1000;
    this.pollTimer = setInterval(() => {
      for (const serial of this.bindings.keys()) void this.handleEvent(serial);
    }, intervalMs);
  }

  /**
   * Resolve the configured control server base URL, falling back to localhost.
   *
   * @returns {string} The trimmed base URL.
   */
  private getApiUrl(): string {
    const raw = typeof this.config.apiUrl === 'string' && this.config.apiUrl.length > 0 ? this.config.apiUrl : 'http://localhost:8082';
    return raw;
  }
}

// Re-export the SystemMode constant so consumers can identify modes without re-importing the helper module.
export { SystemMode };
