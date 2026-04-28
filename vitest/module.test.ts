import path from 'node:path';

import { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
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

const mocks = vi.hoisted(() => ({
  listDevices: vi.fn(),
  getStatus: vi.fn(),
  sendCommand: vi.fn(),
  subscribeEvents: vi.fn(),
}));

vi.mock('../src/nle-client.js', () => ({
  listDevices: mocks.listDevices,
  getStatus: mocks.getStatus,
  sendCommand: mocks.sendCommand,
  subscribeEvents: mocks.subscribeEvents,
}));

const { NoLongerEvilThermostatPlatform, SystemMode } = await import('../src/module.js');

const mockLog = {
  fatal: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  notice: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as AnsiLogger;

const mockMatterbridge: PlatformMatterbridge = {
  systemInformation: {
    ipv4Address: '192.168.1.1',
    ipv6Address: 'fd78:cbf8:4939:746:a96:8277:346f:416e',
    osRelease: 'x.y.z',
    nodeVersion: '22.10.0',
  },
  rootDirectory: path.join('.cache', 'vitest', 'NlePlugin'),
  homeDirectory: path.join('.cache', 'vitest', 'NlePlugin'),
  matterbridgeDirectory: path.join('.cache', 'vitest', 'NlePlugin', '.matterbridge'),
  matterbridgePluginDirectory: path.join('.cache', 'vitest', 'NlePlugin', 'Matterbridge'),
  matterbridgeCertDirectory: path.join('.cache', 'vitest', 'NlePlugin', '.mattercert'),
  globalModulesDirectory: path.join('.cache', 'vitest', 'NlePlugin', 'node_modules'),
  matterbridgeVersion: '3.5.0',
  matterbridgeLatestVersion: '3.5.0',
  matterbridgeDevVersion: '3.5.0',
  bridgeMode: 'bridge',
  restartMode: '',
  aggregatorVendorId: VendorId(0xfff1),
  aggregatorVendorName: 'Matterbridge',
  aggregatorProductId: 0x8000,
  aggregatorProductName: 'Matterbridge aggregator',
  registerVirtualDevice: vi.fn(async () => {}),
  addBridgedEndpoint: vi.fn(async () => {}),
  removeBridgedEndpoint: vi.fn(async () => {}),
  removeAllBridgedEndpoints: vi.fn(async () => {}),
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

vi.spyOn(AnsiLogger.prototype, 'log').mockImplementation(() => {});

function injectMatterNode(instance: any): void {
  instance.setMatterNode(
    // @ts-expect-error Test-only mock surface
    mockMatterbridge.addBridgedEndpoint,
    // @ts-expect-error Test-only mock surface
    mockMatterbridge.removeBridgedEndpoint,
    // @ts-expect-error Test-only mock surface
    mockMatterbridge.removeAllBridgedEndpoints,
    // @ts-expect-error Test-only mock surface
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
  vi.clearAllMocks();
  mocks.listDevices.mockReset();
  mocks.getStatus.mockReset();
  mocks.sendCommand.mockReset();
  mocks.subscribeEvents.mockReset();
  mocks.subscribeEvents.mockResolvedValue(undefined);
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
    mocks.listDevices.mockResolvedValueOnce([sampleDevice]);
    mocks.getStatus.mockResolvedValueOnce(statusFor());
    await platform.onStart('test');
    const ids = platform.getDevices().map((d) => d.originalId);
    expect(ids).toEqual(expect.arrayContaining(['nle-thermo-S1', 'nle-away-S1']));
    await platform.onShutdown('test');
  });

  it('logs and continues when listDevices fails', async () => {
    const platform = await buildInstance();
    mocks.listDevices.mockRejectedValueOnce(new Error('connect refused'));
    await platform.onStart();
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('connect refused'));
    await platform.onShutdown();
  });

  it('falls back to localhost when apiUrl is missing', async () => {
    const platform = await buildInstance({ apiUrl: '' });
    mocks.listDevices.mockResolvedValueOnce([]);
    await platform.onStart();
    expect(mocks.listDevices).toHaveBeenCalledWith('http://localhost:8082');
    await platform.onShutdown();
  });
});

describe('command handlers', () => {
  it('translates SystemMode writes into set_mode commands', async () => {
    const platform = await buildInstance();
    mocks.listDevices.mockResolvedValueOnce([sampleDevice]);
    mocks.getStatus.mockResolvedValueOnce(statusFor());
    mocks.sendCommand.mockResolvedValue(undefined);
    await platform.onStart();
    await (platform as any).handleSystemModeWrite((platform as any).bindings.get('S1'), SystemMode.Cool);
    expect(mocks.sendCommand).toHaveBeenCalledWith('http://server:8082', 'S1', { command: 'set_mode', value: 'cool' });
    await platform.onShutdown();
  });

  it('translates a heat-mode setpoint write into set_temperature', async () => {
    const platform = await buildInstance();
    mocks.listDevices.mockResolvedValueOnce([sampleDevice]);
    mocks.getStatus.mockResolvedValueOnce(statusFor({ mode: 'heat' }));
    mocks.sendCommand.mockResolvedValue(undefined);
    await platform.onStart();
    await (platform as any).handleSetpointWrite((platform as any).bindings.get('S1'), 'heat', 2200);
    expect(mocks.sendCommand).toHaveBeenCalledWith('http://server:8082', 'S1', { command: 'set_temperature', value: 22 });
    await platform.onShutdown();
  });

  it('translates away on/off commands into set_away', async () => {
    const platform = await buildInstance();
    mocks.listDevices.mockResolvedValueOnce([sampleDevice]);
    mocks.getStatus.mockResolvedValueOnce(statusFor());
    mocks.sendCommand.mockResolvedValue(undefined);
    await platform.onStart();
    await (platform as any).handleAwayCommand((platform as any).bindings.get('S1'), true);
    expect(mocks.sendCommand).toHaveBeenCalledWith('http://server:8082', 'S1', { command: 'set_away', value: true });
    await platform.onShutdown();
  });
});

describe('SSE-driven updates', () => {
  it('re-fetches status and applies it on each event', async () => {
    const platform = await buildInstance();
    let capturedHooks: SseHooksLike | null = null;
    mocks.subscribeEvents.mockImplementation(async (_url: string, _signal: AbortSignal, hooks: SseHooksLike) => {
      capturedHooks = hooks;
      return new Promise(() => {});
    });
    mocks.listDevices.mockResolvedValueOnce([sampleDevice]);
    mocks.getStatus.mockResolvedValueOnce(statusFor());
    await platform.onStart();
    mocks.getStatus.mockResolvedValueOnce(statusFor({ mode: 'cool' }));
    capturedHooks!.onSerial('S1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
    await platform.onShutdown();
  });

  it('logs lifecycle events at info level', async () => {
    const platform = await buildInstance();
    mocks.subscribeEvents.mockImplementationOnce(async (_url: string, _signal: AbortSignal, hooks: SseHooksLike) => {
      hooks.onConnect?.();
      hooks.onDisconnect?.();
      hooks.onError(new Error('terminated'));
    });
    mocks.listDevices.mockResolvedValueOnce([sampleDevice]);
    mocks.getStatus.mockResolvedValueOnce(statusFor());
    await platform.onStart();
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('SSE event stream connected'));
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('SSE event stream closed by server'));
    await platform.onShutdown();
  });
});

describe('lifecycle hooks', () => {
  it('logs in onConfigure and iterates devices', async () => {
    const platform = await buildInstance();
    mocks.listDevices.mockResolvedValueOnce([sampleDevice]);
    mocks.getStatus.mockResolvedValueOnce(statusFor());
    await platform.onStart();
    await platform.onConfigure();
    expect(mockLog.info).toHaveBeenCalledWith('onConfigure called');
    await platform.onShutdown();
  });

  it('logs in onChangeLoggerLevel', async () => {
    const platform = await buildInstance();
    await platform.onChangeLoggerLevel(LogLevel.DEBUG);
    expect(mockLog.info).toHaveBeenCalledWith(`onChangeLoggerLevel called with: ${LogLevel.DEBUG}`);
  });

  it('aborts SSE and unregisters on shutdown when configured', async () => {
    const platform = await buildInstance({ unregisterOnShutdown: true });
    mocks.listDevices.mockResolvedValueOnce([sampleDevice]);
    mocks.getStatus.mockResolvedValueOnce(statusFor());
    await platform.onStart();
    await platform.onShutdown('test');
    // @ts-expect-error Test-only mock surface
    expect(mockMatterbridge.removeAllBridgedEndpoints).toHaveBeenCalled();
  });
});

describe('endpoint handler wiring', () => {
  it('away on/off command handlers invoke handleAwayCommand', async () => {
    const platform = await buildInstance();
    mocks.listDevices.mockResolvedValueOnce([sampleDevice]);
    mocks.getStatus.mockResolvedValueOnce(statusFor());
    mocks.sendCommand.mockResolvedValue(undefined);
    await platform.onStart();
    const awayEndpoint = platform.getDevices().find((d) => d.originalId === 'nle-away-S1');
    expect(awayEndpoint).toBeDefined();
    await awayEndpoint!.executeCommandHandler('on', {}, 'onOff', {} as any, awayEndpoint!);
    expect(mocks.sendCommand).toHaveBeenCalledWith('http://server:8082', 'S1', { command: 'set_away', value: true });
    await platform.onShutdown();
  });
});
