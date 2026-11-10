import { constants, publicEncrypt } from 'node:crypto';

import {
  extractDeviceMac,
  normalizeCloudIdentity,
  normalizeMac,
  parseBoundedNumber,
} from './models.js';
import {
  ALORAIR_LITE_PUBLIC_KEY,
  CONTINUOUS_HUMIDITY_SENTINEL,
  DEFAULT_CLOUD_BASE_URL,
  HUMIDITY_STEP,
  MAX_AUTO_HUMIDITY,
  MIN_AUTO_HUMIDITY,
} from './settings.js';
import type {
  AlorairFilterSummary,
  MoistureDisplayUnit,
  TemperatureDisplayUnit,
} from './types.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PAGES = 100;
const PAGE_SIZE = 10;
const MAX_FILTERS = 20;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_PATTERN = /^[!-~]{1,8192}$/;

const STATUS_FIELDS = new Set([
  'powerStatus',
  'drainStatus',
  'defrostingStatus',
  'locateFunction',
  'errCode',
  'currentHumidity',
  'inHumidity',
  'outHumidity',
  'inCelsius',
  'outCelsius',
  'inFahrenheit',
  'outFahrenheit',
  'inGkg',
  'outGkg',
  'inGrlb',
  'outGrlb',
  'temperatureUnit',
  'humidityUnit',
  'pints',
  'singleWorktime',
  'cfm',
  'coilTemperature',
  'controlModel',
  'gppHumidity',
  'isHumidityUnit',
]);

const METADATA_FIELDS = new Set([
  'name',
  'productName',
  'machineBrandName',
  'version',
  'firmwareVersion',
  'hardwareVersion',
  'model',
]);

export class AlorairError extends Error {
  public vendorCode: number | null = null;
  public stage: string;

  constructor(message: string, stage = 'request') {
    super(message);
    this.name = 'AlorairError';
    this.stage = stage;
  }
}

export class AuthenticationError extends AlorairError {
  constructor(message: string, stage = 'login') {
    super(message, stage);
    this.name = 'AuthenticationError';
  }
}

export class CannotConnectError extends AlorairError {
  constructor(message: string, stage = 'request') {
    super(message, stage);
    this.name = 'CannotConnectError';
  }
}

export class ProtocolError extends AlorairError {
  constructor(message: string, stage = 'request') {
    super(message, stage);
    this.name = 'ProtocolError';
  }
}

export class CommandError extends AlorairError {
  public readonly outcomeUnknown: boolean;

  constructor(message: string, outcomeUnknown = false) {
    super(message, 'control');
    this.name = 'CommandError';
    this.outcomeUnknown = outcomeUnknown;
  }
}

export function encryptVendorPassword(password: string, publicKeyPem = ALORAIR_LITE_PUBLIC_KEY): string {
  const encoded = Buffer.from(password, 'utf8');
  if (encoded.length === 0 || encoded.length > 117) {
    throw new AuthenticationError('Credentials cannot be encoded for the vendor login.');
  }
  try {
    const encrypted = publicEncrypt(
      {
        key: publicKeyPem,
        padding: constants.RSA_PKCS1_PADDING,
      },
      encoded,
    );
    return encrypted.toString('base64');
  } catch {
    throw new AuthenticationError('Credentials cannot be encoded for the vendor login.');
  }
}

function validateIdentifier(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !IDENTIFIER_PATTERN.test(String(value))) {
    throw new ProtocolError('The vendor returned an invalid identity.');
  }
  return String(value);
}

function parseNumericCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999_999_999) {
    return value;
  }
  if (typeof value === 'string' && /^\d{1,9}$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return null;
}

function parseFiltersFromDetail(detail: Record<string, unknown>): AlorairFilterSummary[] {
  const rawFilters = detail.filter;
  if (!Array.isArray(rawFilters) || rawFilters.length > MAX_FILTERS) {
    return [];
  }
  const summaries: AlorairFilterSummary[] = [];
  const seen = new Set<string>();
  for (const item of rawFilters) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const rec = item as Record<string, unknown>;
    let filterId: string;
    try {
      filterId = validateIdentifier(rec.id);
    } catch {
      continue;
    }
    if (seen.has(filterId) || /^(?:0{12})?[A-Fa-f0-9]{12}$/.test(filterId)) {
      continue;
    }
    seen.add(filterId);
    const recommendedHours = parseBoundedNumber(rec, 'recommendUseHour', 0.01, 1_000_000_000);
    const usedHours = parseBoundedNumber(rec, 'useHour', 0, 1_000_000_000);
    const extensionHours = rec.extendUseHour !== undefined && rec.extendUseHour !== null
      ? parseBoundedNumber(rec, 'extendUseHour', 0, 1_000_000_000) ?? 0
      : 0;
    if (recommendedHours === null || usedHours === null) {
      continue;
    }
    const remainingHours = Math.max(recommendedHours - usedHours, 0);
    summaries.push({
      filterId,
      recommendedHours,
      usedHours,
      extensionHours,
      remainingHours,
      remainingDays: Math.round((remainingHours / 24) * 100) / 100,
      remainingPercent: Math.round((100 * remainingHours / recommendedHours) * 100) / 100,
    });
  }
  return summaries;
}

export interface SanitizedCloudDevice {
  id: string;
  mac: string;
  deviceNum: string;
  fields: Record<string, unknown>;
  filters: AlorairFilterSummary[];
  observedAtUtc: string;
}

function sanitizePublicDevice(device: Record<string, unknown>): SanitizedCloudDevice {
  const deviceNum = normalizeCloudIdentity(device.deviceNum);
  const mac = extractDeviceMac(device.deviceNum);
  const id = validateIdentifier(device.id);
  if (!deviceNum || !mac) {
    throw new ProtocolError('A complete device MAC address is required.');
  }

  const fields: Record<string, unknown> = {
    id,
    deviceNum,
  };

  for (const field of STATUS_FIELDS) {
    const value = device[field];
    if (
      typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value) && value > -1e12 && value < 1e12)
      || (typeof value === 'string' && /^[0-9A-Fa-f:. -]{1,32}$/.test(value))
    ) {
      fields[field] = value;
    }
  }

  for (const field of METADATA_FIELDS) {
    const value = device[field];
    if (typeof value === 'string' && value.length > 0 && value.length <= 128) {
      let hasControl = false;
      for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) < 32) {
          hasControl = true;
          break;
        }
      }
      if (!hasControl) {
        fields[field] = value;
      }
    }
  }

  if (typeof device.updateTimeStr === 'string' && device.updateTimeStr.length <= 64) {
    fields.updateTimeStr = device.updateTimeStr;
  }

  return {
    id,
    mac,
    deviceNum,
    fields,
    filters: parseFiltersFromDetail(device),
    observedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

export interface AlorairCloudClientOptions {
  username: string;
  password: string;
  allowInsecureHttp?: boolean;
  baseUrl?: string;
  publicKeyPem?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class AlorairCloudClient {
  private readonly username: string;
  private readonly password: string;
  private readonly publicKeyPem: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private token: string | null = null;
  private ownerId: string | null = null;
  private authGeneration = 0;
  private loginPromise: Promise<void> | null = null;
  private fatalAuthError: AuthenticationError | null = null;
  private commandQueue: Promise<void> = Promise.resolve();
  private cachedCandidates = new Map<string, Record<string, unknown>>();

  constructor(options: AlorairCloudClientOptions) {
    const rawUrl = options.baseUrl ?? DEFAULT_CLOUD_BASE_URL;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new ProtocolError('Invalid cloud API base URL.');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw new ProtocolError('Invalid cloud API base URL.');
    }
    if (parsed.protocol === 'http:' && !options.allowInsecureHttp) {
      throw new ProtocolError('The vendor uses unencrypted HTTP; explicit allowInsecureHttp consent is required.');
    }
    if (!options.username || options.username.length > 320 || typeof options.password !== 'string' || !options.password) {
      throw new AuthenticationError('An account username and password are required.');
    }
    const timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ProtocolError('The request timeout must be finite and positive.');
    }

    this.username = options.username.trim();
    this.password = options.password;
    this.publicKeyPem = options.publicKeyPem ?? ALORAIR_LITE_PUBLIC_KEY;
    this.baseUrl = rawUrl.replace(/\/+$/, '') + '/';
    this.timeoutMs = timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public get isAuthenticated(): boolean {
    return this.token !== null;
  }

  public get isAuthRejected(): boolean {
    return this.fatalAuthError !== null;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    options: {
      token?: string | null;
      payload?: Record<string, unknown>;
    } = {},
  ): Promise<unknown> {
    const isCommand = method === 'POST' && (
      path === 'iot/device/control'
      || /^iot\/device\/resetFilter\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/.test(path)
    );
    const allowed = isCommand
      || (method === 'POST' && path === 'user/login')
      || (method === 'GET' && (
        path === 'user/getUserInfo'
        || path === 'iot/device/getHistoryDeviceList'
        || /^iot\/device\/getDeviceDetail\/[A-Za-z0-9_-]{1,128}$/.test(path)
      ));

    if (!allowed) {
      throw new ProtocolError('Unsupported cloud endpoint.');
    }

    const headers: Record<string, string> = {
      'env': 'app',
      'platform': '1',
      'lang': 'en',
      'App-Identity': '1',
      'Accept': 'application/json',
    };

    if (options.token !== undefined && options.token !== null) {
      if (!TOKEN_PATTERN.test(options.token)) {
        throw new AuthenticationError('The vendor returned an invalid session token.');
      }
      headers.token = options.token;
    }

    let url = this.baseUrl + path;
    let body: string | undefined;
    if (method === 'GET' && options.payload) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(options.payload)) {
        if (v !== undefined && v !== null) {
          params.set(k, String(v));
        }
      }
      const qs = params.toString();
      if (qs) {
        url += `?${qs}`;
      }
    } else if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.payload ?? {});
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      if (isCommand) {
        throw new CommandError('Command delivery could not be confirmed; it was not retried.', true);
      }
      throw new CannotConnectError('The cloud request could not be completed.');
    }

    try {
      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError('The vendor rejected the session or credentials.');
      }
      if (response.status >= 300 && response.status < 400) {
        if (isCommand) {
          throw new CommandError('Command response redirected; delivery is unconfirmed and was not retried.', true);
        }
        throw new ProtocolError('Cloud redirect refused; credentials were not forwarded.');
      }
      if (response.status !== 200) {
        if (isCommand) {
          throw new CommandError(
            'The vendor returned a command HTTP error; the command was not retried.',
            response.status >= 500,
          );
        }
        throw new CannotConnectError(`The vendor returned HTTP status ${response.status}.`);
      }

      const rawBytes = await this.readBoundedBody(response, isCommand);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawBytes.toString('utf8'));
      } catch {
        if (isCommand) {
          throw new CommandError('Command response was invalid JSON; delivery is unconfirmed and was not retried.', true);
        }
        throw new ProtocolError('The vendor returned invalid JSON.');
      }

      if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
        if (isCommand) {
          throw new CommandError('Command acknowledgement was invalid; delivery is unconfirmed.', true);
        }
        throw new ProtocolError('The vendor returned an unsupported response.');
      }

      const envelope = parsedJson as Record<string, unknown>;
      const code = parseNumericCode(envelope.code);
      if (code !== null && code >= 10000) {
        const err = new AuthenticationError(`The vendor rejected the session or credentials (code ${code}).`);
        err.vendorCode = code;
        throw err;
      }
      if (code !== 200) {
        if (isCommand) {
          throw new CommandError('The vendor did not acknowledge the command.', code === null);
        }
        const err = new ProtocolError(
          `The vendor rejected the request or returned an unsupported response${code !== null ? ` (code ${code})` : ''}.`,
        );
        err.vendorCode = code;
        throw err;
      }

      return envelope.data;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBoundedBody(response: Response, isCommand: boolean): Promise<Buffer> {
    if (!response.body) {
      return Buffer.alloc(0);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        if (isCommand) {
          throw new CommandError('Command response exceeded the size limit; delivery is unconfirmed.', true);
        }
        throw new ProtocolError('Cloud response exceeded the size limit.');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }

  private async performAuthenticate(): Promise<void> {
    if (this.fatalAuthError) {
      throw this.fatalAuthError;
    }
    this.token = null;
    this.ownerId = null;
    this.cachedCandidates.clear();
    try {
      const encryptedPassword = encryptVendorPassword(this.password, this.publicKeyPem);
      const loginData = await this.request('POST', 'user/login', {
        payload: {
          username: this.username,
          password: encryptedPassword,
          method: 1,
        },
      });
      const loginObj = loginData && typeof loginData === 'object'
        ? (loginData as Record<string, unknown>)
        : null;
      const token = loginObj ? loginObj.token : null;
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
        const stats = loginObj?.stats;
        if (stats === 2) {
          throw new AuthenticationError(
            'Account email is not registered on the AlorAir-Lite server (stats=2). Sign up in the AlorAir-Lite mobile app first.',
            'login',
          );
        }
        if (stats === 3) {
          throw new AuthenticationError(
            'Incorrect AlorAir-Lite account password (stats=3).',
            'login',
          );
        }
        throw new AuthenticationError('The vendor login did not return a usable session.', 'login');
      }
      const userData = await this.request('GET', 'user/getUserInfo', { token });
      if (!userData || typeof userData !== 'object') {
        throw new ProtocolError('The vendor did not return an account identity.', 'user_info');
      }
      const uid = validateIdentifier((userData as Record<string, unknown>).uid);
      this.ownerId = uid;
      this.token = token;
      this.fatalAuthError = null;
    } catch (err) {
      if (err instanceof AuthenticationError) {
        this.fatalAuthError = err;
      }
      throw err;
    } finally {
      this.authGeneration += 1;
    }
  }

  public async login(): Promise<void> {
    if (this.token !== null) {
      return;
    }
    if (!this.loginPromise) {
      this.loginPromise = this.performAuthenticate().finally(() => {
        this.loginPromise = null;
      });
    }
    await this.loginPromise;
  }

  private async refreshSession(rejectedToken: string | null, generation: number): Promise<void> {
    if (this.token !== null && (this.token !== rejectedToken || this.authGeneration !== generation)) {
      return;
    }
    if (!this.loginPromise) {
      this.loginPromise = this.performAuthenticate().finally(() => {
        this.loginPromise = null;
      });
    }
    await this.loginPromise;
  }

  private async read(path: string, payload?: Record<string, unknown>): Promise<unknown> {
    await this.login();
    const token = this.token;
    const generation = this.authGeneration;
    try {
      return await this.request('GET', path, { token, payload });
    } catch (err) {
      if (err instanceof AuthenticationError) {
        await this.refreshSession(token, generation);
        return await this.request('GET', path, { token: this.token, payload });
      }
      throw err;
    }
  }

  private async fetchCandidateDevices(): Promise<Map<string, Record<string, unknown>>> {
    const devices = new Map<string, Record<string, unknown>>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.read('iot/device/getHistoryDeviceList', {
        pageNum: page,
        pageSize: PAGE_SIZE,
      });
      if (!data || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>).list)) {
        throw new ProtocolError('The vendor returned an unsupported device list.', 'device_list');
      }
      const rec = data as { totalPage?: unknown; list: unknown[] };
      const totalPages = parseNumericCode(rec.totalPage);
      if (totalPages === null || totalPages < 0 || totalPages > MAX_PAGES || rec.list.length > PAGE_SIZE) {
        throw new ProtocolError('Device pagination exceeded the supported bounds.', 'device_list');
      }

      for (const item of rec.list) {
        if (!item || typeof item !== 'object') {
          throw new ProtocolError('The vendor returned an invalid device entry.', 'device_list');
        }
        const entry = item as Record<string, unknown>;
        if (entry.userId !== undefined && entry.userId !== null && validateIdentifier(entry.userId) !== this.ownerId) {
          continue;
        }
        const mac = extractDeviceMac(entry.deviceNum);
        const deviceNum = normalizeCloudIdentity(entry.deviceNum);
        if (!mac || !deviceNum) {
          throw new ProtocolError('A complete device MAC address is required.', 'device_list');
        }
        const deviceId = validateIdentifier(entry.id);
        const existing = devices.get(mac);
        if (
          existing
          && (validateIdentifier(existing.id) !== deviceId || normalizeCloudIdentity(existing.deviceNum) !== deviceNum)
        ) {
          throw new ProtocolError('The vendor returned conflicting device identities.', 'device_list');
        }
        devices.set(mac, { ...entry });
      }

      if (page >= totalPages) {
        return devices;
      }
    }
    throw new ProtocolError('Device pagination did not terminate.', 'device_list');
  }

  private async getDeviceDetail(candidate: Record<string, unknown>): Promise<Record<string, unknown>> {
    const deviceId = validateIdentifier(candidate.id);
    const detail = await this.read(`iot/device/getDeviceDetail/${deviceId}`);
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      throw new ProtocolError('Device detail did not match the requested identity.', 'device_detail');
    }
    const rec = detail as Record<string, unknown>;
    if (
      normalizeCloudIdentity(rec.deviceNum) !== normalizeCloudIdentity(candidate.deviceNum)
      || ('id' in rec && rec.id !== undefined && rec.id !== null && validateIdentifier(rec.id) !== deviceId)
    ) {
      throw new ProtocolError('Device detail did not match the requested identity.', 'device_detail');
    }
    return rec;
  }

  /**
   * Discover all devices owned by the authenticated AlorAir-Lite account (excludes guest entries).
   */
  public async discoverOwnedDevices(): Promise<SanitizedCloudDevice[]> {
    await this.login();
    this.cachedCandidates = await this.fetchCandidateDevices();
    const owned: SanitizedCloudDevice[] = [];
    for (const candidate of this.cachedCandidates.values()) {
      const detail = await this.getDeviceDetail(candidate);
      if (detail.userId !== undefined && detail.userId !== null && validateIdentifier(detail.userId) === this.ownerId) {
        owned.push(sanitizePublicDevice({ id: candidate.id, ...detail }));
      }
    }
    return owned;
  }

  private async resolveOwnedDevice(macInput: string): Promise<SanitizedCloudDevice> {
    const targetMac = normalizeMac(macInput);
    if (!targetMac) {
      throw new ProtocolError('A complete device MAC address is required.');
    }
    await this.login();
    if (!this.cachedCandidates.has(targetMac)) {
      this.cachedCandidates = await this.fetchCandidateDevices();
    }
    const candidate = this.cachedCandidates.get(targetMac);
    if (!candidate) {
      throw new ProtocolError(
        `The exact MAC ${targetMac} was not found among this account's owned devices.`,
        'device_list',
      );
    }
    const detail = await this.getDeviceDetail(candidate);
    if (detail.userId === undefined || detail.userId === null || validateIdentifier(detail.userId) !== this.ownerId) {
      throw new ProtocolError('Device ownership could not be verified.', 'device_detail');
    }
    return sanitizePublicDevice({ id: candidate.id, ...detail });
  }

  public async getStatus(macInput: string): Promise<SanitizedCloudDevice> {
    return this.resolveOwnedDevice(macInput);
  }

  private enqueueCommand<T>(work: () => Promise<T>): Promise<T> {
    const next = this.commandQueue.then(work, work);
    this.commandQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async sendControlCommand(macInput: string, frameType: string | number, dataValue: string): Promise<void> {
    await this.enqueueCommand(async () => {
      const owned = await this.resolveOwnedDevice(macInput);
      const payload: Record<string, unknown> = {
        deviceId: owned.id,
        frameType,
        data: dataValue,
      };
      // Display-unit commands (24 and 25) omit deviceNum and pass frameType as a JSON number.
      if (frameType !== 24 && frameType !== 25) {
        payload.deviceNum = owned.deviceNum;
      }
      // Never blindly retry a command POST: a timeout may mean the appliance already received it.
      await this.request('POST', 'iot/device/control', {
        token: this.token,
        payload,
      });
    });
  }

  public async setPower(mac: string, on: boolean): Promise<void> {
    await this.sendControlCommand(mac, '21', on ? '01' : '00');
  }

  public async setHumidity(mac: string, target: number): Promise<void> {
    const validAuto = target >= MIN_AUTO_HUMIDITY && target <= MAX_AUTO_HUMIDITY && target % HUMIDITY_STEP === 0;
    if (!Number.isInteger(target) || (target !== CONTINUOUS_HUMIDITY_SENTINEL && !validAuto)) {
      throw new CommandError('Humidity must be 20 (continuous) or 25-80 in steps of 5.');
    }
    await this.sendControlCommand(mac, '23', String(target));
  }

  public async purge(mac: string): Promise<void> {
    await this.sendControlCommand(mac, '22', '01');
  }

  public async setLocate(mac: string, on: boolean): Promise<void> {
    await this.sendControlCommand(mac, '27', on ? '01' : '00');
  }

  public async setTemperatureUnit(mac: string, unit: TemperatureDisplayUnit): Promise<void> {
    await this.sendControlCommand(mac, 24, unit === 'fahrenheit' ? '01' : '00');
  }

  public async setMoistureUnit(mac: string, unit: MoistureDisplayUnit): Promise<void> {
    await this.sendControlCommand(mac, 25, unit === 'grams_per_kilogram' ? '01' : '00');
  }

  public async resetFilter(mac: string, filterIdInput?: string): Promise<void> {
    await this.enqueueCommand(async () => {
      const owned = await this.resolveOwnedDevice(mac);
      const targetFilter = filterIdInput
        ? owned.filters.find((f) => f.filterId === filterIdInput)
        : owned.filters[0];
      if (!targetFilter) {
        throw new CommandError('No matching filter record is attached to this device.');
      }
      const path = `iot/device/resetFilter/${validateIdentifier(owned.id)}/${validateIdentifier(targetFilter.filterId)}`;
      await this.request('POST', path, {
        token: this.token,
        payload: {},
      });
    });
  }
}

