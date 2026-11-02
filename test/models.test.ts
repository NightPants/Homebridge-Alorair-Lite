import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractDeviceMac,
  formatMacColon,
  interpretTargetHumidityField,
  isCloudSampleStale,
  isTargetReachedIdle,
  normalizeCloudIdentity,
  normalizeHomeKitThresholdToTarget,
  normalizeMac,
  parseBinaryFlag,
  parseBoundedNumber,
  parseFaultCodes,
  parseHexCode,
  parseMoistureUnit,
  parsePowered,
  parseTemperatureUnit,
  parseVendorTimestampMs,
  sanitizeHomeKitFirmwareVersion,
} from '../src/models.js';

describe('models & telemetry sanitization', () => {
  it('normalizes valid MAC formats and rejects partial or malformed strings', () => {
    assert.equal(normalizeMac('aabbccddeeff'), 'AABBCCDDEEFF');
    assert.equal(normalizeMac('aa:bb:cc:dd:ee:ff'), 'AABBCCDDEEFF');
    assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'AABBCCDDEEFF');
    assert.equal(normalizeMac('000000000000aabbccddeeff'), 'AABBCCDDEEFF');

    assert.equal(normalizeMac('aabbcc'), null);
    assert.equal(normalizeMac('aa:bb:cc:dd:ee'), null);
    assert.equal(normalizeMac('000000000001aabbccddeeff'), null);
    assert.equal(normalizeMac(123456), null);
  });

  it('formats 12-hex MACs with colons and preserves full cloud identities', () => {
    assert.equal(formatMacColon('aabbcc112233'), 'AA:BB:CC:11:22:33');
    assert.equal(normalizeCloudIdentity('000000000000aabbcc112233'), '000000000000AABBCC112233');
    assert.equal(extractDeviceMac('000000000000aabbcc112233'), 'AABBCC112233');
  });

  it('parses bounded numbers while preserving zero and rejecting booleans or non-finite values', () => {
    assert.equal(parseBoundedNumber({ v: 0 }, 'v', 0, 100), 0);
    assert.equal(parseBoundedNumber({ v: '45.5' }, 'v', 0, 100), 45.5);
    assert.equal(parseBoundedNumber({ v: '-12' }, 'v', -50, 100), -12);
    assert.equal(parseBoundedNumber({ v: true }, 'v', 0, 100), null);
    assert.equal(parseBoundedNumber({ v: '' }, 'v', 0, 100), null);
    assert.equal(parseBoundedNumber({ v: 105 }, 'v', 0, 100), null);
    assert.equal(parseBoundedNumber({ v: Number.NaN }, 'v', 0, 100), null);
  });

  it('parses vendor hex status codes, powerStatus ("00", "01", "02"), and binary flags', () => {
    assert.equal(parseHexCode({ code: '1' }, 'code'), '01');
    assert.equal(parseHexCode({ code: '2a' }, 'code'), '2A');
    assert.equal(parseHexCode({ code: 2 }, 'code'), '02');
    assert.equal(parseHexCode({ code: 'zz' }, 'code'), null);

    assert.equal(parsePowered({ powerStatus: '00' }), false);
    assert.equal(parsePowered({ powerStatus: '01' }), true);
    assert.equal(parsePowered({ powerStatus: '02' }), true);
    assert.equal(parsePowered({ powerStatus: '03' }), null);

    assert.equal(isTargetReachedIdle({ powerStatus: '02' }), true);
    assert.equal(isTargetReachedIdle({ powerStatus: '01' }), false);

    assert.equal(parseBinaryFlag({ drainStatus: '01' }, 'drainStatus'), true);
    assert.equal(parseBinaryFlag({ drainStatus: '00' }, 'drainStatus'), false);
    assert.equal(parseBinaryFlag({ drainStatus: '02' }, 'drainStatus'), null);
  });

  it('decodes AlorAir-Lite fault bitmasks while ignoring bit 5 (0x20)', () => {
    assert.deepEqual(parseFaultCodes({ errCode: '00' }), []);
    assert.deepEqual(parseFaultCodes({ errCode: '20' }), []);
    assert.deepEqual(parseFaultCodes({ errCode: '01' }), ['E1']);
    assert.deepEqual(parseFaultCodes({ errCode: '25' }), ['E1', 'HI']);
    assert.deepEqual(parseFaultCodes({ errCode: 'DF' }), ['E1', 'L0', 'HI', 'E5', 'E4', 'E3', 'E7']);
  });

  it('parses display units and naive UTC vendor timestamps', () => {
    assert.equal(parseTemperatureUnit({ temperatureUnit: 0 }), 'celsius');
    assert.equal(parseTemperatureUnit({ temperatureUnit: 1 }), 'fahrenheit');
    assert.equal(parseMoistureUnit({ humidityUnit: 0 }), 'grains_per_pound');
    assert.equal(parseMoistureUnit({ humidityUnit: 1 }), 'grams_per_kilogram');

    const tsMs = parseVendorTimestampMs('2026-11-02 15:00:00');
    assert.equal(tsMs, Date.parse('2026-11-02T15:00:00Z'));
    assert.equal(isCloudSampleStale(tsMs, Date.parse('2026-11-02T15:05:00Z')), false);
    assert.equal(isCloudSampleStale(tsMs, Date.parse('2026-11-02T15:20:00Z')), true);
  });

  it('maps target humidity and HomeKit dehumidifier slider thresholds accurately', () => {
    assert.deepEqual(interpretTargetHumidityField(20), { mode: 'continuous', targetHumidity: null });
    assert.deepEqual(interpretTargetHumidityField(50), { mode: 'auto', targetHumidity: 50 });
    assert.deepEqual(interpretTargetHumidityField(42), { mode: null, targetHumidity: null });

    assert.equal(normalizeHomeKitThresholdToTarget(20), 20);
    assert.equal(normalizeHomeKitThresholdToTarget(22), 20);
    assert.equal(normalizeHomeKitThresholdToTarget(23), 25);
    assert.equal(normalizeHomeKitThresholdToTarget(48), 50);
    assert.equal(normalizeHomeKitThresholdToTarget(95), 80);

    assert.equal(sanitizeHomeKitFirmwareVersion('v2.4'), '2.4.0');
    assert.equal(sanitizeHomeKitFirmwareVersion('1.0.8-rc1'), '1.0.8');
    assert.equal(sanitizeHomeKitFirmwareVersion('unknown'), '1.0.0');
  });
});

