import path from 'node:path';

import { jest } from '@jest/globals';
import { MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';

import type { NleStatus } from '../src/matter-mapping.js';
import type { NleDevice } from '../src/nle-client.js';

interface SseHooksLike {
  onSerial: (serial: string) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError: (error: unknown) => void;
}

const listDevicesMock = jest.fn<(apiUrl: string) => Promise<NleDevice[]>>();
const getStatusMock = jest.fn<(apiUrl: string, serial: string) => Promise<NleStatus>>();
const sendCommandMock = jest.fn<(apiUrl: string, serial: string, command: unknown) => Promise<void>>();
const subscribeEventsMock = jest.fn<(apiUrl: string, signal: AbortSignal, hooks: SseHooksLike) => Promise<void>>();

jest.unstable_mockModule('../src/nle-client.js', () => ({
  listDevices: listDevicesMock,
  getStatus: getStatusMock,
  sendCommand: sendCommandMock,
  subscribeEvents: subscribeEventsMock,
}));

const { NoLongerEvilThermostatPlatform, SystemMode } = await import('../src/module.js');

const mockLog = {
  fatal: jest.fn((message: string, ...parameters: any[]) => {}),
  error: jest.fn((message: string, ...parameters: any[]) => {}),
  warn: jest.fn((message: string, ...parameters: any[]) => {}),
  notice: jest.fn((message: string, ...parameters: any[]) => {}),
  info: jest.fn((message: string, ...parameters: any[]) => {}),
  debug: jest.fn((message: string, ...parameters: any[]) => {}),
} as unknown as AnsiLogger;

const mockMatterbridge: PlatformMatterbridge = {
  systemInformation: {
    ipv4Address: '192.168.1.1',
    ipv6Address: 'fd78:cbf8:4939:746:a96:8277:346f:416e',
    osRelease: 'x.y.z',
    nodeVersion: '22.10.0',
  },
  rootDirectory: path.join('.cache', 'jest', 'NlePlugin'),
  homeDirectory: path.join('.cache', 'jest', 'NlePlugin'),
  matterbridgeDirectory: path.join('.cache', 'jest', 'NlePlugin', '.matterbridge'),
  matterbridgePluginDirectory: path.join('.cache', 'jest', 'NlePlugin', 'Matterbridge'),
  matterbridgeCertDirectory: path.join('.cache', 'jest', 'NlePlugin', '.mattercert'),
  globalModulesDirectory: path.join('.cache', 'jest', 'NlePlugin', 'node_modules'),
  matterbridgeVersion: '3.5.0',
  matterbridgeLatestVersion: '3.5.0',
  matterbridgeDevVersion: '3.5.0',
  bridgeMode: 'bridge',
  restartMode: '',
  aggregatorVendorId: VendorId(0xfff1),
  aggregatorVendorName: 'Matterbridge',
  aggregatorProductId: 0x8000,
  aggregatorProductName: 'Matterbridge aggregator',
  registerVirtualDevice: jest.fn(async (name: string, type: 'light' | 'outlet' | 'switch' | 'mounted_switch', callback: () => Promise<void>) => {}),
  addBridgedEndpoint: jest.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {}),
  removeBridgedEndpoint: jest.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {}),
  removeAllBridgedEndpoints: jest.fn(async (pluginName: string) => {}),
} as unknown as PlatformMatterbridge;

const baseConfig: PlatformConfig = {
  name: 'matterbridge-plugin-nolongerevil-thermostat',
  type: 'DynamicPlatform',
  version: '1.0.0',
  apiUrl: 'http://server:8082',
  pollIntervalSeconds: 0,
  whiteList: [],
  blackList: [],
  debug: false,
  unregisterOnShutdown: false,
};

const sampleDevice: NleDevice = { id: 'd1', serial: 'S1', name: 'Living Room' };

function statusFor(overrides: Partial<NleStatus> = {}): NleStatus {
  return {
    serial: 'S1',
    name: 'Living Room',
    is_available: true,
    is_online: true,
    current_temperature: 20,
    target_temperature: 21,
    target_temperature_high: 24,
    target_temperature_low: 18,
    mode: 'heat',
    can_heat: true,
    can_cool: true,
    has_fan: false,
    away: false,
    ...overrides,
  };
}

const loggerLogSpy = jest.spyOn(AnsiLogger.prototype, 'log').mockImplementation((level: string, message: string, ...parameters: any[]) => {});

function injectMatterNode(instance: any): void {
  instance.setMatterNode(
    // @ts-expect-error Accessing test-only mock surface for matter node injection
    mockMatterbridge.addBridgedEndpoint,
    // @ts-expect-error Accessing test-only mock surface for matter node injection
    mockMatterbridge.removeBridgedEndpoint,
    // @ts-expect-error Accessing test-only mock surface for matter node injection
    mockMatterbridge.removeAllBridgedEndpoints,
    // @ts-expect-error Accessing test-only mock surface for matter node injection
    mockMatterbridge.registerVirtualDevice,
  );
}

async function buildInstance(configOverrides: Partial<PlatformConfig> = {}): Promise<InstanceType<typeof NoLongerEvilThermostatPlatform>> {
  const cfg: PlatformConfig = { ...baseConfig, ...configOverrides };
  // @ts-expect-error mutate readonly for test scenarios
  mockMatterbridge.matterbridgeVersion = '3.5.0';
  const platform = new NoLongerEvilThermostatPlatform(mockMatterbridge, mockLog, cfg);
  injectMatterNode(platform);
  return platform;
}

beforeEach(() => {
  jest.clearAllMocks();
  listDevicesMock.mockReset();
  getStatusMock.mockReset();
  sendCommandMock.mockReset();
  subscribeEventsMock.mockReset();
  subscribeEventsMock.mockResolvedValue(undefined);
});

afterAll(() => {
  loggerLogSpy.mockRestore();
});

describe('NoLongerEvilThermostatPlatform construction', () => {
  it('throws if Matterbridge is below 3.4.0', () => {
    // @ts-expect-error mutate readonly for test scenarios
    mockMatterbridge.matterbridgeVersion = '2.0.0';
    expect(() => new NoLongerEvilThermostatPlatform(mockMatterbridge, mockLog, baseConfig)).toThrow(/3\.4\.0/);
    // @ts-expect-error mutate readonly for test scenarios
    mockMatterbridge.matterbridgeVersion = '3.5.0';
  });

  it('default-exports an initializer that constructs the platform', async () => {
    const init = (await import('../src/module.js')).default;
    const instance = init(mockMatterbridge, mockLog, baseConfig);
    expect(instance).toBeInstanceOf(NoLongerEvilThermostatPlatform);
  });
});

describe('discovery and registration', () => {
  it('registers a thermostat + away switch per device', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());

    await platform.onStart('test');

    expect(listDevicesMock).toHaveBeenCalledWith('http://server:8082');
    expect(getStatusMock).toHaveBeenCalledWith('http://server:8082', 'S1');
    const deviceIds = platform.getDevices().map((d) => d.originalId);
    expect(deviceIds).toEqual(expect.arrayContaining(['nle-thermo-S1', 'nle-away-S1']));
    expect(subscribeEventsMock).toHaveBeenCalledTimes(1);
    await platform.onShutdown('test');
  });

  it('skips devices excluded by the whitelist', async () => {
    const platform = await buildInstance({ whiteList: ['SomethingElse'] });
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);

    await platform.onStart();

    expect(getStatusMock).not.toHaveBeenCalled();
    expect(platform.getDevices()).toHaveLength(0);
    expect(subscribeEventsMock).not.toHaveBeenCalled();
    await platform.onShutdown();
  });

  it('logs and continues when listDevices fails', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockRejectedValueOnce(new Error('connect refused'));

    await platform.onStart();

    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('connect refused'));
    expect(platform.getDevices()).toHaveLength(0);
    await platform.onShutdown();
  });

  it('logs and continues when getStatus for one device fails', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice, { id: 'd2', serial: 'S2', name: 'Bedroom' }]);
    getStatusMock.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(statusFor({ serial: 'S2', name: 'Bedroom' }));

    await platform.onStart();

    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    const ids = platform.getDevices().map((d) => d.originalId);
    expect(ids).toEqual(expect.arrayContaining(['nle-thermo-S2']));
    expect(ids).not.toContain('nle-thermo-S1');
    await platform.onShutdown();
  });

  it('falls back to localhost when apiUrl is missing', async () => {
    const platform = await buildInstance({ apiUrl: '' });
    listDevicesMock.mockResolvedValueOnce([]);
    await platform.onStart();
    expect(listDevicesMock).toHaveBeenCalledWith('http://localhost:8082');
    await platform.onShutdown();
  });

  it('handles a device with a null name', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([{ id: 'd1', serial: 'S9', name: null }]);
    getStatusMock.mockResolvedValueOnce(statusFor({ serial: 'S9', name: null }));
    await platform.onStart();
    expect(platform.getDevices().some((d) => d.originalId === 'nle-thermo-S9')).toBe(true);
    await platform.onShutdown();
  });

  it('logs an error when endpoint construction throws', async () => {
    const spy = jest.spyOn(MatterbridgeEndpoint.prototype, 'createDefaultThermostatClusterServer').mockImplementation(() => {
      throw new Error('cluster init failed');
    });

    try {
      const platform = await buildInstance();
      listDevicesMock.mockResolvedValueOnce([sampleDevice]);
      getStatusMock.mockResolvedValueOnce(statusFor());
      await platform.onStart();

      expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('cluster init failed'));
      expect(platform.getDevices()).toHaveLength(0);
      await platform.onShutdown();
    } finally {
      spy.mockRestore();
    }
  });

  it('logs an error when registerDevice throws and forgets the binding', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    const original = (platform as any).registerDevice.bind(platform);
    (platform as any).registerDevice = jest.fn(async (...args: unknown[]) => {
      void original;
      void args;
      throw new Error('register failed');
    });

    await platform.onStart();
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('register failed'));
    expect((platform as any).bindings.size).toBe(0);
    await platform.onShutdown();
  });
});

describe('command handlers', () => {
  it('translates SystemMode writes into set_mode commands', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    sendCommandMock.mockResolvedValue(undefined);
    await platform.onStart();

    await (platform as any).handleSystemModeWrite((platform as any).bindings.get('S1'), SystemMode.Cool);
    expect(sendCommandMock).toHaveBeenCalledWith('http://server:8082', 'S1', { command: 'set_mode', value: 'cool' });
    await platform.onShutdown();
  });

  it('skips SystemMode writes while syncing', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    await platform.onStart();
    const binding = (platform as any).bindings.get('S1');
    binding.syncing = true;
    await (platform as any).handleSystemModeWrite(binding, SystemMode.Heat);
    expect(sendCommandMock).not.toHaveBeenCalled();
    await platform.onShutdown();
  });

  it('logs but swallows set_mode failures', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    sendCommandMock.mockRejectedValueOnce(new Error('500'));
    await platform.onStart();
    await (platform as any).handleSystemModeWrite((platform as any).bindings.get('S1'), SystemMode.Heat);
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('set_mode failed'));
    await platform.onShutdown();
  });

  it('translates a heat-mode setpoint write into set_temperature', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor({ mode: 'heat' }));
    sendCommandMock.mockResolvedValue(undefined);
    await platform.onStart();
    await (platform as any).handleSetpointWrite((platform as any).bindings.get('S1'), 'heat', 2200);
    expect(sendCommandMock).toHaveBeenCalledWith('http://server:8082', 'S1', { command: 'set_temperature', value: 22 });
    await platform.onShutdown();
  });

  it('ignores a heat-setpoint write while in cool mode', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor({ mode: 'cool' }));
    await platform.onStart();
    await (platform as any).handleSetpointWrite((platform as any).bindings.get('S1'), 'heat', 2200);
    expect(sendCommandMock).not.toHaveBeenCalled();
    await platform.onShutdown();
  });

  it('sends both bounds when in range mode', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor({ mode: 'range', target_temperature_low: 18, target_temperature_high: 24 }));
    sendCommandMock.mockResolvedValue(undefined);
    await platform.onStart();

    const binding = (platform as any).bindings.get('S1');
    binding.thermostat.getAttribute = () => 2400;
    await (platform as any).handleSetpointWrite(binding, 'heat', 1900);

    expect(sendCommandMock).toHaveBeenCalledWith('http://server:8082', 'S1', { command: 'set_temperature', value: { high: 24, low: 19 } });
    await platform.onShutdown();
  });

  it('logs failure of a range setpoint write', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor({ mode: 'range', target_temperature_low: 18, target_temperature_high: 24 }));
    sendCommandMock.mockRejectedValueOnce(new Error('400'));
    await platform.onStart();
    await (platform as any).handleSetpointWrite((platform as any).bindings.get('S1'), 'cool', 2500);
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('set_temperature (range) failed'));
    await platform.onShutdown();
  });

  it('handles range write when sibling attribute is unreadable', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor({ mode: 'range', target_temperature_low: 18, target_temperature_high: 24 }));
    sendCommandMock.mockResolvedValue(undefined);
    await platform.onStart();

    const binding = (platform as any).bindings.get('S1');
    binding.thermostat.getAttribute = () => undefined;
    await (platform as any).handleSetpointWrite(binding, 'heat', 1900);
    expect(sendCommandMock).toHaveBeenCalledWith('http://server:8082', 'S1', expect.objectContaining({ command: 'set_temperature' }));
    await platform.onShutdown();
  });

  it('logs failure of a regular setpoint write', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor({ mode: 'heat' }));
    sendCommandMock.mockRejectedValueOnce(new Error('500'));
    await platform.onStart();
    await (platform as any).handleSetpointWrite((platform as any).bindings.get('S1'), 'heat', 2200);
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('set_temperature failed'));
    await platform.onShutdown();
  });

  it('skips setpoint writes while syncing', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    await platform.onStart();
    const binding = (platform as any).bindings.get('S1');
    binding.syncing = true;
    await (platform as any).handleSetpointWrite(binding, 'heat', 2200);
    expect(sendCommandMock).not.toHaveBeenCalled();
    await platform.onShutdown();
  });

  it('translates away on/off commands into set_away', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    sendCommandMock.mockResolvedValue(undefined);
    await platform.onStart();

    await (platform as any).handleAwayCommand((platform as any).bindings.get('S1'), true);
    expect(sendCommandMock).toHaveBeenCalledWith('http://server:8082', 'S1', { command: 'set_away', value: true });

    sendCommandMock.mockRejectedValueOnce(new Error('boom'));
    await (platform as any).handleAwayCommand((platform as any).bindings.get('S1'), false);
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('set_away failed'));
    await platform.onShutdown();
  });
});

describe('SSE-driven updates', () => {
  it('re-fetches status and applies it on each event', async () => {
    const platform = await buildInstance();
    let capturedHooks: SseHooksLike | null = null;
    subscribeEventsMock.mockImplementation(async (_url, _signal, hooks) => {
      capturedHooks = hooks;
      return new Promise(() => {});
    });
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    await platform.onStart();

    getStatusMock.mockResolvedValueOnce(statusFor({ mode: 'cool', target_temperature: 23 }));
    expect(capturedHooks).not.toBeNull();
    capturedHooks!.onSerial('S1');
    await new Promise((resolve) => setImmediate(resolve));

    expect(getStatusMock).toHaveBeenCalledTimes(2);
    await platform.onShutdown();
  });

  it('ignores events for unknown serials', async () => {
    const platform = await buildInstance();
    let capturedHooks: SseHooksLike | null = null;
    subscribeEventsMock.mockImplementation(async (_url, _signal, hooks) => {
      capturedHooks = hooks;
      return new Promise(() => {});
    });
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    await platform.onStart();

    getStatusMock.mockClear();
    capturedHooks!.onSerial('UNKNOWN');
    await new Promise((resolve) => setImmediate(resolve));
    expect(getStatusMock).not.toHaveBeenCalled();
    await platform.onShutdown();
  });

  it('logs lifecycle events at info level', async () => {
    const platform = await buildInstance();
    subscribeEventsMock.mockImplementationOnce(async (_url, _signal, hooks) => {
      hooks.onConnect?.();
      hooks.onDisconnect?.();
      hooks.onError(new Error('terminated'));
    });
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    await platform.onStart();
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('SSE event stream connected'));
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('SSE event stream closed by server'));
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('terminated'));
    await platform.onShutdown();
  });

  it('falls back to String(error) for non-Error error values', async () => {
    const platform = await buildInstance();
    subscribeEventsMock.mockImplementationOnce(async (_url, _signal, hooks) => {
      hooks.onError({ toString: () => 'opaque' });
    });
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    await platform.onStart();
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('opaque'));
    await platform.onShutdown();
  });

  it('logs and continues when applying an event fails', async () => {
    const platform = await buildInstance();
    let capturedHooks: SseHooksLike | null = null;
    subscribeEventsMock.mockImplementation(async (_url, _signal, hooks) => {
      capturedHooks = hooks;
      return new Promise(() => {});
    });
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    await platform.onStart();

    getStatusMock.mockRejectedValueOnce(new Error('refused'));
    capturedHooks!.onSerial('S1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to apply event'));
    await platform.onShutdown();
  });
});

describe('defensive polling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('polls every interval to re-sync state', async () => {
    const platform = await buildInstance({ pollIntervalSeconds: 30 });
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    await platform.onStart();

    getStatusMock.mockClear();
    getStatusMock.mockResolvedValue(statusFor());
    jest.advanceTimersByTime(31_000);
    await Promise.resolve();
    expect(getStatusMock).toHaveBeenCalled();
    await platform.onShutdown();
  });

  it('does not start a poll when the interval is zero', async () => {
    const platform = await buildInstance({ pollIntervalSeconds: 0 });
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    await platform.onStart();
    expect((platform as any).pollTimer).toBeNull();
    await platform.onShutdown();
  });

  it('does not start a poll when no bindings exist', async () => {
    const platform = await buildInstance({ pollIntervalSeconds: 60 });
    listDevicesMock.mockResolvedValueOnce([]);
    await platform.onStart();
    expect((platform as any).pollTimer).toBeNull();
    await platform.onShutdown();
  });

  it('ignores non-numeric poll interval', async () => {
    const platform = await buildInstance({ pollIntervalSeconds: 'whatever' as unknown as number });
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    await platform.onStart();
    expect((platform as any).pollTimer).toBeNull();
    await platform.onShutdown();
  });
});

describe('endpoint handler wiring', () => {
  it('away on/off command handlers invoke handleAwayCommand', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    sendCommandMock.mockResolvedValue(undefined);
    await platform.onStart();

    const awayEndpoint = platform.getDevices().find((d) => d.originalId === 'nle-away-S1');
    expect(awayEndpoint).toBeDefined();
    await awayEndpoint!.executeCommandHandler('on', {}, 'onOff', {} as any, awayEndpoint!);
    await awayEndpoint!.executeCommandHandler('off', {}, 'onOff', {} as any, awayEndpoint!);

    expect(sendCommandMock).toHaveBeenCalledWith('http://server:8082', 'S1', { command: 'set_away', value: true });
    expect(sendCommandMock).toHaveBeenCalledWith('http://server:8082', 'S1', { command: 'set_away', value: false });
    await platform.onShutdown();
  });

  it('thermostat attribute listeners invoke their respective handlers', async () => {
    const captured = new Map<string, (newValue: unknown) => void>();
    const subscribeSpy = jest
      .spyOn(MatterbridgeEndpoint.prototype, 'subscribeAttribute')

      .mockImplementation(function (this: any, _cluster: unknown, attribute: any, listener: any) {
        if (this.originalId === 'nle-thermo-S1') captured.set(attribute as string, listener as (v: unknown) => void);
        return Promise.resolve(true);
      } as any);

    try {
      const platform = await buildInstance();
      listDevicesMock.mockResolvedValueOnce([sampleDevice]);
      getStatusMock.mockResolvedValueOnce(statusFor({ mode: 'heat' }));
      sendCommandMock.mockResolvedValue(undefined);
      await platform.onStart();

      captured.get('systemMode')!(SystemMode.Cool);
      captured.get('occupiedHeatingSetpoint')!(2200);
      captured.get('occupiedCoolingSetpoint')!(2500);
      await new Promise((resolve) => setImmediate(resolve));

      expect(sendCommandMock).toHaveBeenCalledWith('http://server:8082', 'S1', { command: 'set_mode', value: 'cool' });
      expect(sendCommandMock).toHaveBeenCalledWith('http://server:8082', 'S1', expect.objectContaining({ command: 'set_temperature' }));
      await platform.onShutdown();
    } finally {
      subscribeSpy.mockRestore();
    }
  });
});

describe('lifecycle hooks', () => {
  it('logs in onConfigure and iterates devices', async () => {
    const platform = await buildInstance();
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    await platform.onStart();

    await platform.onConfigure();
    expect(mockLog.info).toHaveBeenCalledWith('onConfigure called');
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('Configuring device'));
    await platform.onShutdown();
  });

  it('logs in onChangeLoggerLevel', async () => {
    const platform = await buildInstance();
    await platform.onChangeLoggerLevel(LogLevel.DEBUG);
    expect(mockLog.info).toHaveBeenCalledWith(`onChangeLoggerLevel called with: ${LogLevel.DEBUG}`);
  });

  it('aborts SSE and clears timer on shutdown, with optional unregister', async () => {
    const platform = await buildInstance({ pollIntervalSeconds: 30, unregisterOnShutdown: true });
    listDevicesMock.mockResolvedValueOnce([sampleDevice]);
    getStatusMock.mockResolvedValueOnce(statusFor());
    await platform.onStart();

    expect((platform as any).sseAbort).not.toBeNull();
    expect((platform as any).pollTimer).not.toBeNull();
    await platform.onShutdown('Jest');
    expect((platform as any).sseAbort).toBeNull();
    expect((platform as any).pollTimer).toBeNull();
    // @ts-expect-error Test-only mock surface
    expect(mockMatterbridge.removeAllBridgedEndpoints).toHaveBeenCalled();
  });
});
