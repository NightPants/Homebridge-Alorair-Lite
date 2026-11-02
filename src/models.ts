import {
  CLOUD_FUTURE_SKEW_SECONDS,
  CLOUD_STALE_SECONDS,
  CONTINUOUS_HUMIDITY_SENTINEL,
  HUMIDITY_STEP,
  MAX_AUTO_HUMIDITY,
  MIN_AUTO_HUMIDITY,
} from './settings.js';
import type { DehumidifierMode, MoistureDisplayUnit, TemperatureDisplayUnit } from './types.js';

export const FAULT_BITS: ReadonlyArray<readonly [number, string]> = [
  [0, 'E1'],
  [1, 'L0'],
  [2, 'HI'],
  [3, 'E5'],
  [4, 'E4'],
  // Bit 5 (0x20) is ignored by the AlorAir-Lite app fault display (not an asserted fault).
  [6, 'E3'],
  [7, 'E7'],
];

const MAC_PATTERN = /^[0-9a-fA-F]{12}$|^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$|^(?:[0-9a-fA-F]{2}-){5}[0-9a-fA-F]{2}$/;
const PADDED_CLOUD_NUM_PATTERN = /^0{12}[0-9a-fA-F]{12}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;

/**
 * Normalize a complete 12-hex-digit MAC address; never accept partial substrings.
 */
export function normalizeMac(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (PADDED_CLOUD_NUM_PATTERN.test(trimmed)) {
    return trimmed.slice(-12).toUpperCase();
  }
  if (!MAC_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/[:-]/g, '').toUpperCase();
}

/**
 * Format a 12-character MAC address as AA:BB:CC:DD:EE:FF for display.
 */
export function formatMacColon(mac: string): string {
  const clean = normalizeMac(mac);
  if (!clean) {
    return mac;
  }
  return clean.match(/.{1,2}/g)?.join(':') ?? clean;
}

/**
 * Validate a full cloud deviceNum (either 12 zeros + 12 hex digits, or a standard MAC).
 */
export function normalizeCloudIdentity(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (PADDED_CLOUD_NUM_PATTERN.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return normalizeMac(trimmed);
}

/**
 * Extract the 12-character MAC from a validated cloud deviceNum or MAC string.
 */
export function extractDeviceMac(value: unknown): string | null {
  const identity = normalizeCloudIdentity(value);
  return identity ? identity.slice(-12).toUpperCase() : null;
}

/**
 * Reject absent, boolean, non-finite, and out-of-range numeric fields. Preserves legitimate 0.
 */
export function parseBoundedNumber(
  data: Record<string, unknown>,
  key: string,
  low = -10000,
  high = 10000,
): number | null {
  const raw = data[key];
  if (raw === null || raw === undefined || typeof raw === 'boolean' || raw === '') {
    return null;
  }
  if (typeof raw === 'string' && !/^-?\d{1,10}(?:\.\d{1,8})?$/.test(raw.trim())) {
    return null;
  }
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num) || num < low || num > high) {
    return null;
  }
  return num;
}

/**
 * Normalize vendor 1-2 digit hexadecimal status codes into uppercase 2-digit strings ("00", "01", etc.).
 */
export function parseHexCode(data: Record<string, unknown>, key: string): string | null {
  const raw = data[key];
  if (typeof raw === 'string' && /^[0-9a-fA-F]{1,2}$/.test(raw.trim())) {
    return raw.trim().toUpperCase().padStart(2, '0');
  }
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 255) {
    return raw.toString(16).toUpperCase().padStart(2, '0');
  }
  return null;
}

/**
 * Interpret cloud powerStatus: "00" = off, "01" = enabled, "02" = enabled & target reached (idle).
 */
export function parsePowered(data: Record<string, unknown>): boolean | null {
  const status = parseHexCode(data, 'powerStatus');
  if (status === '00') {
    return false;
  }
  if (status === '01' || status === '02') {
    return true;
  }
  return null;
}

export function isTargetReachedIdle(data: Record<string, unknown>): boolean {
  return parseHexCode(data, 'powerStatus') === '02';
}

export function parseBinaryFlag(data: Record<string, unknown>, key: string): boolean | null {
  const status = parseHexCode(data, key);
  if (status === '01') {
    return true;
  }
  if (status === '00') {
    return false;
  }
  return null;
}

/**
 * Parse hexadecimal errCode bitmask into known AlorAir-Lite display codes.
 * Bit 0x20 is intentionally ignored per the vendor Lite app's fault display.
 */
export function parseFaultCodes(data: Record<string, unknown>): string[] | null {
  const hex = parseHexCode(data, 'errCode');
  if (hex === null) {
    return null;
  }
  const mask = Number.parseInt(hex, 16);
  const active: string[] = [];
  for (const [bit, label] of FAULT_BITS) {
    if ((mask & (1 << bit)) !== 0) {
      active.push(label);
    }
  }
  return active;
}

export function parseTemperatureUnit(data: Record<string, unknown>): TemperatureDisplayUnit | null {
  const val = parseBoundedNumber(data, 'temperatureUnit', 0, 1);
  if (val === 0) {
    return 'celsius';
  }
  if (val === 1) {
    return 'fahrenheit';
  }
  return null;
}

export function parseMoistureUnit(data: Record<string, unknown>): MoistureDisplayUnit | null {
  const val = parseBoundedNumber(data, 'humidityUnit', 0, 1);
  if (val === 0) {
    return 'grains_per_pound';
  }
  if (val === 1) {
    return 'grams_per_kilogram';
  }
  return null;
}

/**
 * Parse vendor updateTimeStr. Naive timestamps (no Z or offset) are interpreted as UTC
 * matching the AlorAir-Lite mobile app's date formatter.
 */
export function parseVendorTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    return null;
  }
  const hasZone = /(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value);
  const iso = value.replace(' ', 'T') + (hasZone ? '' : 'Z');
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isCloudSampleStale(
  sampleTimestampMs: number | null,
  nowMs = Date.now(),
  maxAgeSeconds = CLOUD_STALE_SECONDS,
): boolean {
  if (sampleTimestampMs === null) {
    return true;
  }
  const ageSeconds = (nowMs - sampleTimestampMs) / 1000;
  return ageSeconds < -CLOUD_FUTURE_SKEW_SECONDS || ageSeconds > maxAgeSeconds;
}

/**
 * Interpret vendor currentHumidity (which is the target RH%, or 20 for Continuous mode).
 */
export function interpretTargetHumidityField(rawTarget: number | null): {
  mode: DehumidifierMode | null;
  targetHumidity: number | null;
} {
  if (rawTarget === null || !Number.isInteger(rawTarget)) {
    return { mode: null, targetHumidity: null };
  }
  if (rawTarget === CONTINUOUS_HUMIDITY_SENTINEL) {
    return { mode: 'continuous', targetHumidity: null };
  }
  if (rawTarget >= MIN_AUTO_HUMIDITY && rawTarget <= MAX_AUTO_HUMIDITY && rawTarget % HUMIDITY_STEP === 0) {
    return { mode: 'auto', targetHumidity: rawTarget };
  }
  return { mode: null, targetHumidity: null };
}

/**
 * Convert a HomeKit RelativeHumidityDehumidifierThreshold slider value into a valid AlorAir-Lite target:
 * - Values <= 22 snap to 20 (Continuous / "CO" mode)
 * - Values > 22 clamp to [25, 80] and snap to the nearest 5% increment
 */
export function normalizeHomeKitThresholdToTarget(value: number): number {
  if (!Number.isFinite(value)) {
    return 50;
  }
  if (value <= 22) {
    return CONTINUOUS_HUMIDITY_SENTINEL;
  }
  const clamped = Math.min(MAX_AUTO_HUMIDITY, Math.max(MIN_AUTO_HUMIDITY, value));
  return Math.round(clamped / HUMIDITY_STEP) * HUMIDITY_STEP;
}

/**
 * Sanitize firmware version strings into strict X.Y.Z format expected by HomeKit AccessoryInformation.
 */
export function sanitizeHomeKitFirmwareVersion(version: string | undefined | null): string {
  if (!version) {
    return '1.0.0';
  }
  const match = version.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) {
    return '1.0.0';
  }
  const major = match[1] ?? '1';
  const minor = match[2] ?? '0';
  const patch = match[3] ?? '0';
  return `${major}.${minor}.${patch}`;
}

