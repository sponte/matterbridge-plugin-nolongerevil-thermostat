/**
 * Pure mapping helpers between No Longer Evil thermostat state and Matter Thermostat cluster values.
 *
 * Matter spec references: Matter 1.4 §9.1 Thermostat (Device), Thermostat cluster (id 0x0201).
 * No Longer Evil API surface: docs.nolongerevil.com (self-hosted control server).
 *
 * @file matter-mapping.ts
 * @license Apache-2.0
 */

/**
 * No Longer Evil HVAC mode values returned by the self-hosted /status endpoint
 * and accepted by /command set_mode.
 */
export type NleMode = 'off' | 'heat' | 'cool' | 'range' | 'emergency';

/**
 * Subset of /status fields used by the plugin.
 *
 * The self-hosted API returns many additional fields; only the ones that influence
 * Matter attribute decisions are typed here.
 */
export interface NleStatus {
  serial: string;
  name?: string | null;
  is_available?: boolean;
  is_online?: boolean;
  current_temperature: number | null;
  target_temperature: number | null;
  target_temperature_high: number | null;
  target_temperature_low: number | null;
  mode: NleMode | null;
  can_heat?: boolean;
  can_cool?: boolean;
  has_fan?: boolean;
  away?: boolean;
}

/** Matter Thermostat cluster SystemMode enum values (matter.js). */
export const SystemMode = {
  Off: 0,
  Auto: 1,
  Cool: 3,
  Heat: 4,
  EmergencyHeat: 5,
} as const;

/** Matter Thermostat cluster ControlSequenceOfOperation enum values. */
export const ControlSequenceOfOperation = {
  CoolingOnly: 0,
  HeatingOnly: 2,
  CoolingAndHeating: 4,
} as const;

/** Inclusive temperature bounds enforced by the No Longer Evil API, in degrees Celsius. */
export const NLE_MIN_C = 4.5;
export const NLE_MAX_C = 32;

/** Matter encodes temperatures as int16 hundredths of a degree Celsius. */
export const MATTER_INT16_MIN = -32768;
export const MATTER_INT16_MAX = 32767;

/**
 * Convert a No Longer Evil mode string to a Matter SystemMode enum value.
 *
 * Edge cases:
 *  - "range" maps to Auto (1) — Matter's auto/range concept.
 *  - "emergency" maps to EmergencyHeat (5).
 *  - null/unknown -> Off (0) so the controller renders a deterministic state.
 *
 * @param {NleMode | null | undefined} mode No Longer Evil mode or nullish value.
 * @returns {number} Matter Thermostat SystemMode enum value.
 */
export function nleModeToSystemMode(mode: NleMode | null | undefined): number {
  switch (mode) {
    case 'heat':
      return SystemMode.Heat;
    case 'cool':
      return SystemMode.Cool;
    case 'range':
      return SystemMode.Auto;
    case 'emergency':
      return SystemMode.EmergencyHeat;
    case 'off':
    default:
      return SystemMode.Off;
  }
}

/**
 * Convert a Matter SystemMode enum value to the corresponding No Longer Evil mode string.
 *
 * Edge cases:
 *  - Auto -> "heat-cool" (the wire value the /command set_mode endpoint expects, distinct from /status "range").
 *  - EmergencyHeat -> "emergency".
 *  - Unknown values fall back to "off".
 *
 * Note: NLE uses "range" in /status responses but "heat-cool" in /command requests for the same concept.
 *
 * @param {number} systemMode Matter SystemMode enum value.
 * @returns {string} String accepted by the No Longer Evil set_mode command.
 */
export function systemModeToNleCommand(systemMode: number): 'off' | 'heat' | 'cool' | 'heat-cool' | 'emergency' {
  switch (systemMode) {
    case SystemMode.Heat:
      return 'heat';
    case SystemMode.Cool:
      return 'cool';
    case SystemMode.Auto:
      return 'heat-cool';
    case SystemMode.EmergencyHeat:
      return 'emergency';
    case SystemMode.Off:
    default:
      return 'off';
  }
}

/**
 * Derive the Matter ControlSequenceOfOperation value from device capability flags.
 *
 * Edge cases:
 *  - Both false -> CoolingOnly (a sensible default that prevents Matter clients from rejecting the cluster).
 *
 * @param {boolean | undefined} canHeat Whether the system can heat.
 * @param {boolean | undefined} canCool Whether the system can cool.
 * @returns {number} ControlSequenceOfOperation enum value.
 */
export function controlSequenceFor(canHeat: boolean | undefined, canCool: boolean | undefined): number {
  if (canHeat && canCool) return ControlSequenceOfOperation.CoolingAndHeating;
  if (canHeat) return ControlSequenceOfOperation.HeatingOnly;
  return ControlSequenceOfOperation.CoolingOnly;
}

/**
 * Encode degrees Celsius as Matter int16 hundredths-of-degree.
 *
 * Edge cases:
 *  - Non-finite -> null (caller should treat as "no value").
 *  - Result is clamped to int16 range.
 *
 * @param {number | null | undefined} celsius Temperature in degrees Celsius.
 * @returns {number | null} Matter-encoded value (Celsius * 100, rounded, int16-clamped) or null.
 */
export function cToMatter(celsius: number | null | undefined): number | null {
  if (celsius === null || celsius === undefined || !Number.isFinite(celsius)) return null;
  const encoded = Math.round(celsius * 100);
  return Math.max(MATTER_INT16_MIN, Math.min(MATTER_INT16_MAX, encoded));
}

/**
 * Decode Matter int16 hundredths-of-degree to degrees Celsius.
 *
 * Edge cases:
 *  - Non-finite -> NaN (caller should validate).
 *
 * @param {number} matter Matter-encoded temperature (Celsius * 100).
 * @returns {number} Degrees Celsius.
 */
export function matterToC(matter: number): number {
  if (!Number.isFinite(matter)) return NaN;
  return matter / 100;
}

/**
 * Clamp a Celsius setpoint to the bounds the No Longer Evil API accepts.
 *
 * Edge cases:
 *  - Non-finite -> NLE_MIN_C as a safe floor.
 *
 * @param {number} celsius Requested setpoint in degrees Celsius.
 * @returns {number} Setpoint clamped to [NLE_MIN_C, NLE_MAX_C].
 */
export function clampSetpointC(celsius: number): number {
  if (!Number.isFinite(celsius)) return NLE_MIN_C;
  return Math.max(NLE_MIN_C, Math.min(NLE_MAX_C, celsius));
}

/**
 * Effective heating and cooling setpoints to expose on the Matter Thermostat cluster.
 *
 * Behavior follows the No Longer Evil mode semantics:
 *  - heat: heat = target_temperature, cool = NLE_MAX_C placeholder.
 *  - cool: cool = target_temperature, heat = NLE_MIN_C placeholder.
 *  - range: heat = target_temperature_low, cool = target_temperature_high.
 *  - off / emergency / null: best-effort fallback using whichever target value is non-null.
 *
 * Edge cases:
 *  - Missing values fall back to the corresponding NLE bound so the cluster always reports valid setpoints.
 *
 * @param {NleStatus} status Status payload from the /status endpoint.
 * @returns {{ heat: number; cool: number }} Heating and cooling setpoints in degrees Celsius.
 */
export function extractSetpoints(status: NleStatus): { heat: number; cool: number } {
  const target = Number.isFinite(status.target_temperature ?? NaN) ? (status.target_temperature as number) : null;
  const high = Number.isFinite(status.target_temperature_high ?? NaN) ? (status.target_temperature_high as number) : null;
  const low = Number.isFinite(status.target_temperature_low ?? NaN) ? (status.target_temperature_low as number) : null;

  switch (status.mode) {
    case 'heat':
      return { heat: target ?? NLE_MIN_C, cool: NLE_MAX_C };
    case 'cool':
      return { heat: NLE_MIN_C, cool: target ?? NLE_MAX_C };
    case 'range':
      return { heat: low ?? NLE_MIN_C, cool: high ?? NLE_MAX_C };
    case 'emergency':
      return { heat: target ?? NLE_MIN_C, cool: NLE_MAX_C };
    case 'off':
    default:
      return { heat: target ?? low ?? NLE_MIN_C, cool: target ?? high ?? NLE_MAX_C };
  }
}
