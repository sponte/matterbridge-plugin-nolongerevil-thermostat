import {
  clampSetpointC,
  controlSequenceFor,
  ControlSequenceOfOperation,
  cToMatter,
  extractSetpoints,
  matterToC,
  NLE_MAX_C,
  NLE_MIN_C,
  nleModeToSystemMode,
  NleStatus,
  SystemMode,
  systemModeToNleCommand,
} from '../src/matter-mapping.js';

const baseStatus: NleStatus = {
  serial: 'TEST',
  current_temperature: null,
  target_temperature: null,
  target_temperature_high: null,
  target_temperature_low: null,
  mode: null,
};

describe('nleModeToSystemMode', () => {
  it.each([
    ['heat', SystemMode.Heat],
    ['cool', SystemMode.Cool],
    ['range', SystemMode.Auto],
    ['emergency', SystemMode.EmergencyHeat],
    ['off', SystemMode.Off],
  ] as const)('maps NLE mode %s to SystemMode %d', (mode, expected) => {
    expect(nleModeToSystemMode(mode)).toBe(expected);
  });

  it('treats null and undefined as Off', () => {
    expect(nleModeToSystemMode(null)).toBe(SystemMode.Off);
    expect(nleModeToSystemMode(undefined)).toBe(SystemMode.Off);
  });
});

describe('systemModeToNleCommand', () => {
  it.each([
    [SystemMode.Heat, 'heat'],
    [SystemMode.Cool, 'cool'],
    [SystemMode.Auto, 'heat-cool'],
    [SystemMode.EmergencyHeat, 'emergency'],
    [SystemMode.Off, 'off'],
  ] as const)('maps SystemMode %d to NLE command %s', (sysMode, expected) => {
    expect(systemModeToNleCommand(sysMode)).toBe(expected);
  });

  it('falls back to off for unknown enum values', () => {
    expect(systemModeToNleCommand(99)).toBe('off');
  });
});

describe('controlSequenceFor', () => {
  it('returns CoolingAndHeating when both capabilities present', () => {
    expect(controlSequenceFor(true, true)).toBe(ControlSequenceOfOperation.CoolingAndHeating);
  });

  it('returns HeatingOnly when only heat is present', () => {
    expect(controlSequenceFor(true, false)).toBe(ControlSequenceOfOperation.HeatingOnly);
  });

  it('returns CoolingOnly otherwise', () => {
    expect(controlSequenceFor(false, true)).toBe(ControlSequenceOfOperation.CoolingOnly);
    expect(controlSequenceFor(undefined, undefined)).toBe(ControlSequenceOfOperation.CoolingOnly);
  });
});

describe('cToMatter', () => {
  it('encodes whole degrees', () => {
    expect(cToMatter(20)).toBe(2000);
  });

  it('rounds to nearest hundredth', () => {
    expect(cToMatter(21.555)).toBe(2156);
  });

  it('returns null for nullish or non-finite inputs', () => {
    expect(cToMatter(null)).toBeNull();
    expect(cToMatter(undefined)).toBeNull();
    expect(cToMatter(NaN)).toBeNull();
    expect(cToMatter(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('clamps to int16 bounds', () => {
    expect(cToMatter(1_000_000)).toBe(32767);
    expect(cToMatter(-1_000_000)).toBe(-32768);
  });
});

describe('matterToC', () => {
  it('decodes Matter int16 to Celsius', () => {
    expect(matterToC(2050)).toBe(20.5);
  });

  it('returns NaN for non-finite input', () => {
    expect(Number.isNaN(matterToC(Number.POSITIVE_INFINITY))).toBe(true);
  });
});

describe('clampSetpointC', () => {
  it('clamps below the floor', () => {
    expect(clampSetpointC(-10)).toBe(NLE_MIN_C);
  });

  it('clamps above the ceiling', () => {
    expect(clampSetpointC(100)).toBe(NLE_MAX_C);
  });

  it('passes valid values through', () => {
    expect(clampSetpointC(21.5)).toBe(21.5);
  });

  it('returns the floor for non-finite input', () => {
    expect(clampSetpointC(NaN)).toBe(NLE_MIN_C);
  });
});

describe('extractSetpoints', () => {
  it('returns target as heat in heat mode', () => {
    const result = extractSetpoints({ ...baseStatus, mode: 'heat', target_temperature: 21 });
    expect(result).toEqual({ heat: 21, cool: NLE_MAX_C });
  });

  it('returns target as cool in cool mode', () => {
    const result = extractSetpoints({ ...baseStatus, mode: 'cool', target_temperature: 24 });
    expect(result).toEqual({ heat: NLE_MIN_C, cool: 24 });
  });

  it('returns low/high in range mode', () => {
    const result = extractSetpoints({
      ...baseStatus,
      mode: 'range',
      target_temperature_low: 18,
      target_temperature_high: 26,
    });
    expect(result).toEqual({ heat: 18, cool: 26 });
  });

  it('treats emergency the same as heat', () => {
    const result = extractSetpoints({ ...baseStatus, mode: 'emergency', target_temperature: 22 });
    expect(result).toEqual({ heat: 22, cool: NLE_MAX_C });
  });

  it('falls back to NLE bounds when range values are missing', () => {
    const result = extractSetpoints({ ...baseStatus, mode: 'range' });
    expect(result).toEqual({ heat: NLE_MIN_C, cool: NLE_MAX_C });
  });

  it('falls back gracefully when mode is null/off', () => {
    expect(extractSetpoints({ ...baseStatus, mode: 'off', target_temperature: 19 })).toEqual({ heat: 19, cool: 19 });
    expect(extractSetpoints({ ...baseStatus, mode: null })).toEqual({ heat: NLE_MIN_C, cool: NLE_MAX_C });
  });

  it('falls back to NLE_MIN_C when heat target is missing', () => {
    expect(extractSetpoints({ ...baseStatus, mode: 'heat' })).toEqual({ heat: NLE_MIN_C, cool: NLE_MAX_C });
    expect(extractSetpoints({ ...baseStatus, mode: 'cool' })).toEqual({ heat: NLE_MIN_C, cool: NLE_MAX_C });
    expect(extractSetpoints({ ...baseStatus, mode: 'emergency' })).toEqual({ heat: NLE_MIN_C, cool: NLE_MAX_C });
  });
});
