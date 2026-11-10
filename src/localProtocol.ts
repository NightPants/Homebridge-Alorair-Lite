import {
  CONTINUOUS_HUMIDITY_SENTINEL,
  HUMIDITY_STEP,
  MAX_AUTO_HUMIDITY,
  MIN_AUTO_HUMIDITY,
} from './settings.js';
import type { LocalControllerProfile, TemperatureDisplayUnit } from './types.js';

export const FRAME_MAGIC = Buffer.from([0x0d, 0x0e]);
export const FRAME_TERMINATOR = 0x16;
export const MAX_FRAME_DATA_BYTES = 256;
export const MIN_FRAME_BYTES = 29;

export interface DecodedNativeFrame {
  macHex: string;
  macBytes: Buffer;
  timestamp: number;
  fn: number;
  opcode: number;
  reserved: Buffer;
  data: Buffer;
  classByte?: number;
}

export interface DecodedNativeStatus {
  profile: 'lite' | 'sentinel';
  macHex: string;
  eventOpcode: number;
  power: boolean | null;
  draining: boolean | null;
  compressorActive: boolean | null;
  fanActive: boolean | null;
  locating: boolean | null;
  continuous: boolean | null;
  targetHumidity: number | null;
  inletCelsius: number | null;
  inletHumidity: number | null;
  outletCelsius: number | null;
  outletHumidity: number | null;
  inletGrainsPerPound: number | null;
  inletGramsPerKilogram: number | null;
  outletGrainsPerPound: number | null;
  outletGramsPerKilogram: number | null;
  coilCelsius: number | null;
  workingHours: number | null;
  temperatureUnit: TemperatureDisplayUnit;
}

export function isValidLiteHumidityTarget(target: number): boolean {
  if (!Number.isInteger(target)) {
    return false;
  }
  if (target === CONTINUOUS_HUMIDITY_SENTINEL) {
    return true;
  }
  return target >= MIN_AUTO_HUMIDITY && target <= MAX_AUTO_HUMIDITY && target % HUMIDITY_STEP === 0;
}

export function computeAdditiveChecksum16(prefix: Buffer): number {
  let sum = 0;
  for (let i = 0; i < prefix.length; i++) {
    sum += prefix[i];
  }
  return sum & 0xffff;
}

export function encodeNativeFrame(params: {
  macBytes: Buffer;
  timestamp: number;
  fn: number;
  opcode: number;
  data: Buffer;
  reserved?: Buffer;
  classByte?: number;
}): Buffer {
  const reserved = params.reserved ?? Buffer.alloc(4, 0);
  if (params.macBytes.length !== 6 || reserved.length !== 4) {
    throw new Error('Invalid MAC or reserved field length');
  }
  if (params.data.length > MAX_FRAME_DATA_BYTES || params.timestamp < 0 || params.timestamp > 0xffffffff) {
    throw new Error('Native frame exceeds supported bounds');
  }

  const prefix = Buffer.alloc(26 + params.data.length);
  FRAME_MAGIC.copy(prefix, 0);
  // Bytes 2..7 are 6 reserved zero bytes (already zero-initialized)
  params.macBytes.copy(prefix, 8);
  prefix.writeUInt32BE(params.timestamp >>> 0, 14);
  prefix.writeUInt16BE(params.data.length, 18);
  prefix[20] = params.fn & 0xff;
  prefix[21] = params.opcode & 0xff;
  reserved.copy(prefix, 22);
  params.data.copy(prefix, 26);

  // Trailer is `<class> <checksum8> 0x16` where `<class>` is:
  //   0x05 for cloud->device commands & keepalive-acks
  //   0x02 for device->cloud keepalives
  //   0x04 for device->cloud status frames
  // and `<checksum8>` = sum(all frame bytes before `<class>`) & 0xFF.
  const defaultClassByte = params.fn === 0x09
    ? (params.opcode === 0x01 && params.data.length === 0 ? 0x02 : 0x05)
    : 0x04;
  const classByte = (params.classByte ?? defaultClassByte) & 0xff;
  const checksum = computeAdditiveChecksum16(prefix) & 0xff;
  const trailer = Buffer.from([classByte, checksum, FRAME_TERMINATOR]);
  return Buffer.concat([prefix, trailer]);
}

export function decodeNativeFrame(raw: Buffer, expectedMacBytes?: Buffer | null): DecodedNativeFrame {
  if (raw.length < MIN_FRAME_BYTES) {
    throw new Error('Invalid frame header: shorter than 29 bytes');
  }
  if (raw[0] !== 0x0d || raw[1] !== 0x0e) {
    throw new Error('Invalid frame magic');
  }
  for (let i = 2; i < 8; i++) {
    if (raw[i] !== 0x00) {
      throw new Error('Non-zero header reserved bytes');
    }
  }
  const dataLength = raw.readUInt16BE(18);
  if (dataLength > MAX_FRAME_DATA_BYTES || raw.length !== MIN_FRAME_BYTES + dataLength) {
    throw new Error('Invalid declared frame length');
  }
  if (raw[raw.length - 1] !== FRAME_TERMINATOR) {
    throw new Error('Invalid frame terminator');
  }
  const sumPrefix = computeAdditiveChecksum16(raw.subarray(0, raw.length - 3));
  const classByte = raw[raw.length - 3];
  const actualChecksum8 = raw[raw.length - 2];
  const expectedChecksum8 = sumPrefix & 0xff;
  const sumWithClass = (sumPrefix + classByte) & 0xff;
  const matchesLegacyK = ((sumWithClass + 0xfc) & 0xff) === actualChecksum8
    || ((sumWithClass + 0xfb) & 0xff) === actualChecksum8;
  if (actualChecksum8 !== expectedChecksum8 && !matchesLegacyK) {
    throw new Error(
      `Invalid frame checksum (expected 0x${expectedChecksum8.toString(16).padStart(2, '0')}, `
      + `got 0x${actualChecksum8.toString(16).padStart(2, '0')}, class=0x${classByte.toString(16).padStart(2, '0')})`,
    );
  }

  const macBytes = Buffer.from(raw.subarray(8, 14));
  if (expectedMacBytes && !macBytes.equals(expectedMacBytes)) {
    throw new Error('Unexpected appliance MAC identity');
  }

  return {
    macHex: macBytes.toString('hex').toUpperCase(),
    macBytes,
    timestamp: raw.readUInt32BE(14),
    fn: raw[20],
    opcode: raw[21],
    reserved: Buffer.from(raw.subarray(22, 26)),
    data: Buffer.from(raw.subarray(26, raw.length - 3)),
    classByte,
  };
}

/**
 * Reassemble length-delimited native TCP frames across arbitrary chunk boundaries.
 */
export class NativeFrameStream {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(private readonly expectedMacBytes?: Buffer | null) {}

  public get bufferedBytes(): number {
    return this.buffer.length;
  }

  public feed(chunk: Buffer): Array<{ raw: Buffer; frame: DecodedNativeFrame }> {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const results: Array<{ raw: Buffer; frame: DecodedNativeFrame }> = [];

    while (this.buffer.length >= 20) {
      if (this.buffer[0] !== 0x0d || this.buffer[1] !== 0x0e) {
        throw new Error('Unexpected TCP stream header');
      }
      for (let i = 2; i < 8; i++) {
        if (this.buffer[i] !== 0x00) {
          throw new Error('Unexpected non-zero header bytes in TCP stream');
        }
      }
      const dataLength = this.buffer.readUInt16BE(18);
      const fullSize = MIN_FRAME_BYTES + dataLength;
      if (fullSize > MIN_FRAME_BYTES + MAX_FRAME_DATA_BYTES) {
        throw new Error('Declared stream frame exceeds maximum size');
      }
      if (this.buffer.length < fullSize) {
        break;
      }
      const raw = Buffer.from(this.buffer.subarray(0, fullSize));
      const frame = decodeNativeFrame(raw, this.expectedMacBytes);
      results.push({ raw, frame });
      this.buffer = this.buffer.subarray(fullSize);
    }

    if (this.buffer.length > MIN_FRAME_BYTES + MAX_FRAME_DATA_BYTES) {
      throw new Error('Unbounded partial frame in TCP stream');
    }

    return results;
  }

  public assertCleanEOF(): void {
    if (this.buffer.length > 0) {
      throw new Error('Partial frame remaining at TCP stream EOF');
    }
  }
}

export function buildKeepaliveReply(macBytes: Buffer, timestamp: number): Buffer {
  return encodeNativeFrame({
    macBytes,
    timestamp,
    fn: 0x09,
    opcode: 0x01,
    data: Buffer.from([0x00]),
  });
}

export function buildPowerCommand(macBytes: Buffer, on: boolean, timestamp: number): Buffer {
  return encodeNativeFrame({
    macBytes,
    timestamp,
    fn: 0x09,
    opcode: 0x21,
    data: Buffer.from([on ? 0x01 : 0x00]),
  });
}

export function buildHumidityCommand(
  macBytes: Buffer,
  target: number,
  timestamp: number,
  profile: 'lite' | 'sentinel' = 'lite',
): Buffer {
  if (profile === 'lite' && !isValidLiteHumidityTarget(target)) {
    throw new Error('Lite humidity target must be 20 (continuous) or 25-80 in steps of 5');
  }
  if (profile === 'sentinel' && (!Number.isInteger(target) || target < 20 || target > 90)) {
    throw new Error('Sentinel humidity target must be an integer between 20 and 90');
  }
  return encodeNativeFrame({
    macBytes,
    timestamp,
    fn: 0x09,
    opcode: 0x23,
    data: Buffer.from([target & 0xff]),
  });
}

export function buildTemperatureUnitCommand(
  macBytes: Buffer,
  unit: TemperatureDisplayUnit,
  timestamp: number,
): Buffer {
  return encodeNativeFrame({
    macBytes,
    timestamp,
    fn: 0x09,
    opcode: 0x24,
    data: Buffer.from([unit === 'fahrenheit' ? 0x01 : 0x00]),
  });
}

export function buildPurgeCommand(macBytes: Buffer, timestamp: number): Buffer {
  return encodeNativeFrame({
    macBytes,
    timestamp,
    fn: 0x09,
    opcode: 0x22,
    data: Buffer.from([0x01]),
  });
}

export function buildLocateCommand(macBytes: Buffer, on: boolean, timestamp: number): Buffer {
  return encodeNativeFrame({
    macBytes,
    timestamp,
    fn: 0x09,
    opcode: 0x27,
    data: Buffer.from([on ? 0x01 : 0x00]),
  });
}

function parsePairedSignedCelsius(data: Buffer, index: number): number | null {
  const celsius = data.readInt8(index);
  const fahrenheit = data.readInt8(index + 1);
  return fahrenheit === Math.floor((celsius * 9) / 5 + 32) ? celsius : null;
}

function parseBoundedHumidityByte(value: number): number | null {
  return value >= 0 && value <= 100 ? value : null;
}

/**
 * Decode an AlorAir-Lite (Storm Pro / commercial LGR) 34-byte status payload (fn=0x07, N=34)
 * or, when allowed by controllerProfile, a 45-byte Sentinel payload (fn=0x0B, N=45).
 */
export function decodeObservedStatus(
  frame: DecodedNativeFrame,
  allowedProfile: LocalControllerProfile = 'lite',
): DecodedNativeStatus | null {
  if (
    (allowedProfile === 'lite' || allowedProfile === 'auto')
    && frame.fn === 0x07
    && frame.data.length === 34
  ) {
    const d = frame.data;
    const rawTarget = d[23];
    const validTarget = isValidLiteHumidityTarget(rawTarget)
      ? rawTarget
      : (rawTarget >= 20 && rawTarget <= 90 ? rawTarget : null);
    return {
      profile: 'lite',
      macHex: frame.macHex,
      eventOpcode: frame.opcode,
      power: d[3] === 0 ? false : (d[3] === 1 || d[3] === 2) ? true : null,
      draining: d[4] === 1 ? true : d[4] === 0 ? false : null,
      compressorActive: null,
      fanActive: null,
      locating: null,
      continuous: validTarget === CONTINUOUS_HUMIDITY_SENTINEL ? true : validTarget !== null ? false : null,
      targetHumidity: validTarget,
      inletCelsius: parsePairedSignedCelsius(d, 8) ?? d.readInt8(8),
      inletHumidity: parseBoundedHumidityByte(d[10]),
      outletCelsius: parsePairedSignedCelsius(d, 11),
      outletHumidity: parseBoundedHumidityByte(d[13]),
      inletGrainsPerPound: d.readUInt16BE(14),
      inletGramsPerKilogram: d.readUInt16BE(16),
      outletGrainsPerPound: d.readUInt16BE(18),
      outletGramsPerKilogram: d.readUInt16BE(20),
      coilCelsius: null,
      workingHours: null,
      temperatureUnit: d[32] === 1 ? 'fahrenheit' : 'celsius',
    };
  }

  if (
    (allowedProfile === 'sentinel' || allowedProfile === 'auto')
    && ((frame.fn === 0x0b && frame.data.length >= 45)
      || (allowedProfile === 'auto' && frame.fn !== 0x09 && frame.data.length >= 34))
  ) {
    // 45-byte data payload (body_offset = data_offset + 8 in sethrobin/alorair-local)
    const d = frame.data;
    const rawSetpoint = d[23];
    const isContinuous = (d.length > 44 && d[44] === 0x02) || rawSetpoint < 35;
    return {
      profile: 'sentinel',
      macHex: frame.macHex,
      eventOpcode: frame.opcode,
      power: d[3] === 0 ? false : (d[3] === 1 || d[3] === 2) ? true : null,
      draining: d[4] === 1 ? true : d[4] === 0 ? false : null,
      compressorActive: d[6] === 1,
      fanActive: d[7] === 1,
      locating: d[30] === 1,
      continuous: isContinuous,
      targetHumidity: isContinuous ? CONTINUOUS_HUMIDITY_SENTINEL : rawSetpoint,
      inletCelsius: parsePairedSignedCelsius(d, 8) ?? d.readInt8(8),
      inletHumidity: parseBoundedHumidityByte(d[10]),
      outletCelsius: parsePairedSignedCelsius(d, 11),
      outletHumidity: parseBoundedHumidityByte(d[13]),
      inletGrainsPerPound: d.readUInt16BE(14) || d[15],
      inletGramsPerKilogram: d.readUInt16BE(16) || d[17],
      outletGrainsPerPound: d.readUInt16BE(18) || null,
      outletGramsPerKilogram: d.readUInt16BE(20) || null,
      coilCelsius: d.readInt8(22),
      workingHours: d.readUInt16BE(28),
      temperatureUnit: d[32] === 0 ? 'celsius' : 'fahrenheit',
    };
  }

  return null;
}

