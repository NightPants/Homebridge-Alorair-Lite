import type { Logging } from 'homebridge';

import {
  AlorairCloudClient,
  AlorairError,
  AuthenticationError,
  CannotConnectError,
  CommandError,
  type SanitizedCloudDevice,
} from './cloudApi.js';
import {
  AlorairLocalServer,
  CommandUncertainError as LocalCommandUncertainError,
  type LocalStatusReport,
} from './localServer.js';
import {
  formatMacColon,
  interpretTargetHumidityField,
  isCloudSampleStale,
  isTargetReachedIdle,
  normalizeHomeKitThresholdToTarget,
  parseBinaryFlag,
  parseBoundedNumber,
  parseFaultCodes,
  parseHexCode,
  parseMoistureUnit,
  parsePowered,
  parseTemperatureUnit,
  parseVendorTimestampMs,
} from './models.js';
import {
  CLOUD_STALE_SECONDS,
  CONTINUOUS_HUMIDITY_SENTINEL,
  DEFAULT_AUTO_HUMIDITY,
  LOCAL_STALE_SECONDS,
  MINIMUM_OFF_SECONDS,
  PENDING_COMMAND_SECONDS,
} from './settings.js';
import type {
  AlorairDeviceState,
  CommandFeedback,
  DehumidifierMode,
  MoistureDisplayUnit,
  TemperatureDisplayUnit,
  TransportMode,
} from './types.js';

interface PendingMarker {
  wanted: string | number | boolean;
  deadlineMs: number;
  issuedAtMs: number;
  baselineSampleMs: number | null;
}

export interface CoordinatorOptions {
  mac: string;
  transport: TransportMode;
  cloudClient?: AlorairCloudClient;
  localServer?: AlorairLocalServer;
  pollIntervalSeconds?: number;
  enforceCompressorRestartDelay?: boolean;
  allowLocalPowerOn?: boolean;
  allowExperimentalLocalCommands?: boolean;
  autoPowerOnWhenSettingHumidity?: boolean;
  initialName?: string;
  initialModel?: string;
  initialFirmwareVersion?: string;
  log: Logging;
  debugLogging?: boolean;
}

export class AlorairDeviceCoordinator {
  public readonly mac: string;
  public readonly transport: TransportMode;

  private readonly cloudClient?: AlorairCloudClient;
  private readonly localServer?: AlorairLocalServer;
  private readonly pollIntervalMs: number;
  private readonly enforceRestartDelay: boolean;
  private readonly allowLocalPowerOn: boolean;
  private readonly allowExperimentalLocalCommands: boolean;
  private readonly autoPowerOnWhenSettingHumidity: boolean;
  private readonly log: Logging;
  private readonly debugLogging: boolean;

  private state: AlorairDeviceState;
  private listeners = new Set<(state: AlorairDeviceState) => void>();
  private pending = new Map<string, PendingMarker>();
  private lastOffTimeMs = Date.now();
  private previousPower: boolean | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private commandQueue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(options: CoordinatorOptions) {
    this.mac = options.mac;
    this.transport = options.transport;
    this.cloudClient = options.cloudClient;
    this.localServer = options.localServer;
    this.pollIntervalMs = Math.max(15, options.pollIntervalSeconds ?? 30) * 1000;
    this.enforceRestartDelay = options.enforceCompressorRestartDelay !== false;
    this.allowLocalPowerOn = options.allowLocalPowerOn === true;
    this.allowExperimentalLocalCommands = options.allowExperimentalLocalCommands === true;
    this.autoPowerOnWhenSettingHumidity = options.autoPowerOnWhenSettingHumidity === true;
    this.log = options.log;
    this.debugLogging = options.debugLogging === true;

    this.state = {
      mac: options.mac,
      deviceNum: options.mac,
      name: options.initialName ?? `AlorAir ${formatMacColon(options.mac).slice(-8)}`,
      model: options.initialModel ?? 'AlorAir-Lite LGR Dehumidifier',
      firmwareVersion: options.initialFirmwareVersion ?? '1.0.0',
      transport: options.transport,
      online: false,
      stale: true,
      power: null,
      targetReachedIdle: false,
      mode: null,
      targetHumidity: null,
      lastAutoHumidity: DEFAULT_AUTO_HUMIDITY,
      inletHumidity: null,
      outletHumidity: null,
      inletCelsius: null,
      outletCelsius: null,
      inletGrainsPerPound: null,
      outletGrainsPerPound: null,
      inletGramsPerKilogram: null,
      outletGramsPerKilogram: null,
      coilTemperature: null,
      draining: null,
      defrosting: null,
      locating: null,
      compressorActive: null,
      fanActive: null,
      temperatureUnit: null,
      moistureUnit: null,
      workingHours: null,
      rawErrorMask: null,
      faultCodes: [],
      filters: [],
      sampleTimestampIso: null,
      observedAtIso: null,
      pendingPower: null,
      restartDelayRemainingSeconds: this.enforceRestartDelay ? MINIMUM_OFF_SECONDS : 0,
      lastCommand: null,
    };
  }

  public getState(): AlorairDeviceState {
    return {
      ...this.state,
      pendingPower: this.computePendingPower(),
      restartDelayRemainingSeconds: this.computeRestartDelayRemaining(),
    };
  }

  public onStateUpdate(listener: (state: AlorairDeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitState(): void {
    this.state.pendingPower = this.computePendingPower();
    this.state.restartDelayRemainingSeconds = this.computeRestartDelayRemaining();
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        this.log.error('State listener threw an error:', (err as Error).message);
      }
    }
  }

  private computePendingPower(): 'on' | 'off' | null {
    const marker = this.pending.get('powerStatus');
    if (marker && marker.deadlineMs > Date.now()) {
      return marker.wanted === '00' || marker.wanted === false ? 'off' : 'on';
    }
    return null;
  }

  public computeRestartDelayRemaining(): number {
    if (!this.enforceRestartDelay) {
      return 0;
    }
    if (this.computePendingPower() === 'off') {
      return MINIMUM_OFF_SECONDS;
    }
    if (this.state.power === true && !this.state.stale) {
      return 0;
    }
    const elapsedSeconds = (Date.now() - this.lastOffTimeMs) / 1000;
    return Math.max(0, Math.ceil(MINIMUM_OFF_SECONDS - elapsedSeconds));
  }

  public async start(): Promise<void> {
    this.stopped = false;
    if (this.transport === 'cloud') {
      await this.refreshCloud().catch((err) => {
        if (err instanceof AuthenticationError) {
          this.log.error(
            `Cloud authentication rejected for ${formatMacColon(this.mac)} (${err.message}). Stopping cloud polling to prevent account lockout.`,
          );
          this.stopCloudPolling();
          return;
        }
        this.log.warn(`Initial cloud poll for ${formatMacColon(this.mac)} failed: ${(err as Error).message}`);
      });
      if (!this.cloudClient?.isAuthRejected) {
        this.pollTimer = setInterval(() => {
          void this.refreshCloud().catch((err) => {
            if (err instanceof AuthenticationError) {
              this.log.error(
                `Cloud authentication rejected for ${formatMacColon(this.mac)} (${err.message}). Stopping cloud polling to prevent account lockout.`,
              );
              this.stopCloudPolling();
              return;
            }
            if (this.debugLogging) {
              this.log.debug(`Background cloud poll error (${formatMacColon(this.mac)}): ${(err as Error).message}`);
            }
          });
        }, this.pollIntervalMs);
        this.pollTimer.unref?.();
      }
    }

    this.watchdogTimer = setInterval(() => {
      this.runWatchdog();
    }, 2000);
    this.watchdogTimer.unref?.();
  }

  public stopCloudPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public stop(): void {
    this.stopped = true;
    this.stopCloudPolling();
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private runWatchdog(): void {
    const now = Date.now();
    let changed = false;

    for (const [key, marker] of this.pending.entries()) {
      if (now >= marker.deadlineMs) {
        this.pending.delete(key);
        if (this.state.lastCommand && this.state.lastCommand.field === key && this.state.lastCommand.status === 'awaiting_feedback') {
          this.state.lastCommand = {
            ...this.state.lastCommand,
            status: 'not_observed',
          };
        }
        changed = true;
      }
    }

    if (this.transport === 'local') {
      const report = this.localServer?.lastStatus ?? null;
      const connected = Boolean(this.localServer?.connected);
      const isStale = !connected || !report || (now - report.receivedAtMs) > LOCAL_STALE_SECONDS * 1000;
      if (this.state.online !== connected || this.state.stale !== isStale) {
        this.state.online = connected;
        this.state.stale = isStale;
        changed = true;
      }
    } else if (this.state.sampleTimestampIso) {
      const sampleMs = parseVendorTimestampMs(this.state.sampleTimestampIso);
      const isStale = isCloudSampleStale(sampleMs, now, CLOUD_STALE_SECONDS);
      if (this.state.stale !== isStale) {
        this.state.stale = isStale;
        this.state.online = !isStale;
        changed = true;
      }
    }

    if (changed) {
      this.emitState();
    }
  }

  public applyCloudDeviceSnapshot(snapshot: SanitizedCloudDevice): void {
    const fields = snapshot.fields;
    const power = parsePowered(fields);
    if (power === null) {
      throw new AlorairError('ALORAIR returned an unsupported powerStatus value.');
    }

    if (power === false && this.previousPower === true) {
      this.lastOffTimeMs = Date.now();
    }
    this.previousPower = power;

    const rawTarget = parseBoundedNumber(fields, 'currentHumidity', 20, 80);
    const { mode, targetHumidity } = interpretTargetHumidityField(rawTarget);
    if (targetHumidity !== null) {
      this.state.lastAutoHumidity = targetHumidity;
    }

    const sampleMs = parseVendorTimestampMs(fields.updateTimeStr);
    const stale = isCloudSampleStale(sampleMs);
    const now = Date.now();

    for (const [key, marker] of this.pending.entries()) {
      const actual = key === 'currentHumidity'
        ? parseBoundedNumber(fields, key)
        : parseHexCode(fields, key);
      const matches = actual === marker.wanted || (key === 'powerStatus' && marker.wanted === '01' && power === true);
      const newer = sampleMs !== null
        && sampleMs >= marker.issuedAtMs - 1000
        && (marker.baselineSampleMs === null || sampleMs > marker.baselineSampleMs);

      if (matches && newer) {
        this.pending.delete(key);
        if (this.state.lastCommand && this.state.lastCommand.field === key) {
          this.state.lastCommand = {
            ...this.state.lastCommand,
            status: 'device_reported',
            reportedAtIso: typeof fields.updateTimeStr === 'string' ? fields.updateTimeStr : snapshot.observedAtUtc,
          };
        }
        if (key === 'powerStatus' && marker.wanted === '00') {
          this.lastOffTimeMs = now;
        }
      } else if (now >= marker.deadlineMs) {
        this.pending.delete(key);
        if (this.state.lastCommand && this.state.lastCommand.field === key) {
          this.state.lastCommand = {
            ...this.state.lastCommand,
            status: 'not_observed',
          };
        }
      }
    }

    const friendlyName = (
      (typeof fields.name === 'string' && fields.name.trim())
      || (typeof fields.productName === 'string' && fields.productName.trim())
      || this.state.name
    );
    const modelName = (
      (typeof fields.productName === 'string' && fields.productName.trim())
      || (typeof fields.model === 'string' && fields.model.trim())
      || this.state.model
    );
    const firmware = (
      (typeof fields.firmwareVersion === 'string' && fields.firmwareVersion.trim())
      || (typeof fields.version === 'string' && fields.version.trim())
      || this.state.firmwareVersion
    );

    const faultCodes = parseFaultCodes(fields) ?? [];

    this.state = {
      ...this.state,
      deviceId: snapshot.id,
      deviceNum: snapshot.deviceNum,
      name: friendlyName,
      model: modelName,
      firmwareVersion: firmware,
      hardwareVersion: typeof fields.hardwareVersion === 'string' ? fields.hardwareVersion : this.state.hardwareVersion,
      online: !stale,
      stale,
      power,
      targetReachedIdle: isTargetReachedIdle(fields),
      mode,
      targetHumidity,
      inletHumidity: parseBoundedNumber(fields, 'inHumidity', 0, 100),
      outletHumidity: parseBoundedNumber(fields, 'outHumidity', 0, 100),
      inletCelsius: parseBoundedNumber(fields, 'inCelsius', -50, 100),
      outletCelsius: parseBoundedNumber(fields, 'outCelsius', -50, 100),
      inletGrainsPerPound: parseBoundedNumber(fields, 'inGrlb', 0, 10000),
      outletGrainsPerPound: parseBoundedNumber(fields, 'outGrlb', 0, 10000),
      inletGramsPerKilogram: parseBoundedNumber(fields, 'inGkg', 0, 1000),
      outletGramsPerKilogram: parseBoundedNumber(fields, 'outGkg', 0, 1000),
      coilTemperature: parseBoundedNumber(fields, 'coilTemperature', -100, 250),
      draining: parseBinaryFlag(fields, 'drainStatus'),
      defrosting: parseBinaryFlag(fields, 'defrostingStatus'),
      locating: parseBinaryFlag(fields, 'locateFunction'),
      temperatureUnit: parseTemperatureUnit(fields),
      moistureUnit: parseMoistureUnit(fields),
      workingHours: parseBoundedNumber(fields, 'singleWorktime', 0, 10_000_000),
      rawErrorMask: parseHexCode(fields, 'errCode'),
      faultCodes,
      filters: snapshot.filters,
      sampleTimestampIso: typeof fields.updateTimeStr === 'string' ? fields.updateTimeStr : null,
      observedAtIso: snapshot.observedAtUtc,
    };

    if (this.debugLogging) {
      this.log.info(
        `[${this.state.name}] Cloud poll: power=${String(power)} mode=${String(mode)} `
        + `inRH=${String(this.state.inletHumidity)}% target=${String(targetHumidity)}% faults=${faultCodes.join(',') || 'none'}`,
      );
    }

    this.emitState();
  }

  public applyLocalStatusReport(report: LocalStatusReport): void {
    if (report.power === false && this.previousPower !== false) {
      this.lastOffTimeMs = Date.now();
    }
    this.previousPower = report.power;

    const isContinuous = report.targetHumidity === CONTINUOUS_HUMIDITY_SENTINEL || report.continuous === true;
    const numericTarget = !isContinuous && report.targetHumidity !== null && report.targetHumidity >= 25
      ? report.targetHumidity
      : null;
    if (numericTarget !== null) {
      this.state.lastAutoHumidity = numericTarget;
    }

    const mode: DehumidifierMode | null = report.targetHumidity === null
      ? null
      : isContinuous
        ? 'continuous'
        : 'auto';

    this.state = {
      ...this.state,
      online: true,
      stale: false,
      model: report.profile === 'sentinel' ? 'AlorAir Sentinel (Local TCP)' : this.state.model,
      power: report.power,
      targetReachedIdle: Boolean(
        report.power === true
        && mode === 'auto'
        && numericTarget !== null
        && report.inletHumidity !== null
        && report.inletHumidity <= numericTarget,
      ),
      mode,
      targetHumidity: numericTarget,
      inletHumidity: report.inletHumidity,
      outletHumidity: report.outletHumidity,
      inletCelsius: report.inletCelsius,
      outletCelsius: report.outletCelsius,
      inletGrainsPerPound: report.inletGrainsPerPound,
      outletGrainsPerPound: report.outletGrainsPerPound,
      inletGramsPerKilogram: report.inletGramsPerKilogram,
      outletGramsPerKilogram: report.outletGramsPerKilogram,
      coilTemperature: report.coilCelsius,
      draining: report.draining,
      compressorActive: report.compressorActive,
      fanActive: report.fanActive,
      locating: report.locating,
      temperatureUnit: report.temperatureUnit,
      workingHours: report.workingHours,
      sampleTimestampIso: report.receivedAtIso,
      observedAtIso: report.receivedAtIso,
    };

    this.emitState();
  }

  public handleLocalDisconnect(): void {
    this.previousPower = null;
    this.lastOffTimeMs = Date.now();
    this.state.online = false;
    this.state.stale = true;
    this.emitState();
  }

  public async refreshCloud(): Promise<void> {
    if (!this.cloudClient || this.stopped) {
      return;
    }
    const snapshot = await this.cloudClient.getStatus(this.mac);
    this.applyCloudDeviceSnapshot(snapshot);
  }

  private enqueueAction<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.commandQueue.then(fn, fn);
    this.commandQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  public async setPower(on: boolean): Promise<void> {
    await this.enqueueAction(async () => {
      if (this.stopped) {
        throw new Error('Plugin is shutting down');
      }

      if (this.transport === 'local') {
        await this.executeLocalCommand('set_power', 'powerStatus', on ? '01' : '00', async () => {
          if (!this.localServer || !this.localServer.connected) {
            throw new Error('Local dehumidifier TCP connection is not active');
          }
          if (on) {
            if (!this.allowLocalPowerOn) {
              throw new Error(
                'Local power-on is disabled by default for safety. Enable "allowLocalPowerOn" in plugin settings.',
              );
            }
            if (this.state.stale) {
              throw new Error('Fresh local device status is required before starting');
            }
            const delay = this.computeRestartDelayRemaining();
            if (delay > 0) {
              throw new Error(`Compressor restart protection active (${delay}s remaining)`);
            }
            if (this.state.power === true && !this.pending.has('powerStatus')) {
              return null;
            }
          } else {
            this.lastOffTimeMs = Date.now();
          }
          return await this.localServer.setPower(on);
        });
        return;
      }

      await this.executeCloudCommand(
        'set_power',
        'powerStatus',
        on ? '01' : '00',
        false,
        async () => {
          if (on) {
            if (this.state.power === true && !this.pending.has('powerStatus')) {
              return false;
            }
            const delay = this.computeRestartDelayRemaining();
            if (delay > 0) {
              throw new Error(`Compressor restart protection active (${delay}s remaining)`);
            }
          } else {
            this.lastOffTimeMs = Date.now();
          }
          await this.cloudClient!.setPower(this.mac, on);
          return true;
        },
      );
    });
  }

  public async setDehumidifierThreshold(rawThreshold: number): Promise<void> {
    const target = normalizeHomeKitThresholdToTarget(rawThreshold);
    if (target !== CONTINUOUS_HUMIDITY_SENTINEL) {
      this.state.lastAutoHumidity = target;
    }

    await this.enqueueAction(async () => {
      if (this.stopped) {
        throw new Error('Plugin is shutting down');
      }

      const isCurrentlyOn = this.state.power === true || this.computePendingPower() === 'on';
      if (!isCurrentlyOn) {
        if (!this.autoPowerOnWhenSettingHumidity) {
          this.log.info(
            `[${this.state.name}] Saved desired humidity ${target === 20 ? 'Continuous (CO)' : `${target}%`}; `
            + 'turn the dehumidifier on first (or enable autoPowerOnWhenSettingHumidity) to apply on hardware.',
          );
          this.emitState();
          return;
        }
        // Power on first inside the serialized queue
        await this.powerOnBeforeSetting();
      }

      await this.sendTargetInternal(target);
    });
  }

  public async setContinuousMode(continuous: boolean): Promise<void> {
    const target = continuous ? CONTINUOUS_HUMIDITY_SENTINEL : this.state.lastAutoHumidity;
    await this.setDehumidifierThreshold(target);
  }

  private async powerOnBeforeSetting(): Promise<void> {
    const delay = this.computeRestartDelayRemaining();
    if (delay > 0) {
      throw new Error(`Compressor restart protection active (${delay}s remaining)`);
    }
    if (this.transport === 'local') {
      if (!this.allowLocalPowerOn) {
        throw new Error('Enable "allowLocalPowerOn" in plugin settings before starting locally.');
      }
      const report = await this.localServer!.setPower(true);
      this.applyLocalStatusReport(report);
    } else {
      await this.cloudClient!.setPower(this.mac, true);
      await this.refreshCloud();
    }
  }

  private async sendTargetInternal(target: number): Promise<void> {
    if (this.transport === 'local') {
      await this.executeLocalCommand('set_humidity', 'currentHumidity', target, async () => {
        if (!this.localServer || !this.localServer.connected) {
          throw new Error('Local dehumidifier TCP connection is not active');
        }
        const current = this.state.mode === 'continuous'
          ? CONTINUOUS_HUMIDITY_SENTINEL
          : this.state.targetHumidity;
        if (current === target && !this.state.stale && !this.pending.has('currentHumidity')) {
          return null;
        }
        return await this.localServer.setHumidity(target);
      });
      return;
    }

    await this.executeCloudCommand('set_humidity', 'currentHumidity', target, true, async () => {
      const current = this.state.mode === 'continuous'
        ? CONTINUOUS_HUMIDITY_SENTINEL
        : this.state.targetHumidity;
      if (current === target && !this.pending.has('currentHumidity')) {
        return false;
      }
      await this.cloudClient!.setHumidity(this.mac, target);
      return true;
    });
  }

  public async purge(): Promise<void> {
    await this.enqueueAction(async () => {
      if (this.transport === 'local') {
        if (!this.allowExperimentalLocalCommands && this.localServer?.lastStatus?.profile !== 'sentinel') {
          throw new Error(
            'Remote purge is unverified on AlorAir-Lite local TCP. Switch to Cloud or enable allowExperimentalLocalCommands.',
          );
        }
        await this.executeLocalCommand('purge', 'drainStatus', '01', async () => {
          return await this.localServer!.purge();
        });
        return;
      }

      await this.executeCloudCommand('purge', 'drainStatus', '01', true, async () => {
        await this.cloudClient!.purge(this.mac);
        return true;
      });
    });
  }

  public async setLocate(on: boolean): Promise<void> {
    await this.enqueueAction(async () => {
      if (this.transport === 'local') {
        if (!this.allowExperimentalLocalCommands && this.localServer?.lastStatus?.profile !== 'sentinel') {
          throw new Error(
            'Locate beacon is unverified on AlorAir-Lite local TCP. Switch to Cloud or enable allowExperimentalLocalCommands.',
          );
        }
        await this.executeLocalCommand('set_locate', 'locateFunction', on ? '01' : '00', async () => {
          return await this.localServer!.setLocate(on);
        });
        return;
      }

      await this.executeCloudCommand('set_locate', 'locateFunction', on ? '01' : '00', on, async () => {
        await this.cloudClient!.setLocate(this.mac, on);
        return true;
      });
    });
  }

  public async setTemperatureUnit(unit: TemperatureDisplayUnit): Promise<void> {
    await this.enqueueAction(async () => {
      if (this.transport === 'local') {
        await this.executeLocalCommand('set_temperature_unit', 'temperatureUnit', unit === 'fahrenheit' ? '01' : '00', async () => {
          return await this.localServer!.setTemperatureUnit(unit);
        });
        return;
      }
      await this.executeCloudCommand('set_temperature_unit', 'temperatureUnit', unit === 'fahrenheit' ? '01' : '00', false, async () => {
        await this.cloudClient!.setTemperatureUnit(this.mac, unit);
        return true;
      });
    });
  }

  public async setMoistureUnit(unit: MoistureDisplayUnit): Promise<void> {
    await this.enqueueAction(async () => {
      if (this.transport === 'local') {
        throw new Error('Moisture display unit changes are only supported over the Cloud API.');
      }
      await this.executeCloudCommand('set_moisture_unit', 'humidityUnit', unit === 'grams_per_kilogram' ? '01' : '00', false, async () => {
        await this.cloudClient!.setMoistureUnit(this.mac, unit);
        return true;
      });
    });
  }

  public async resetFilter(): Promise<void> {
    await this.enqueueAction(async () => {
      if (this.transport !== 'cloud' || !this.cloudClient) {
        throw new Error('Filter maintenance counter reset is only available in Cloud mode.');
      }
      await this.cloudClient.resetFilter(this.mac);
      await this.refreshCloud();
    });
  }

  private async executeCloudCommand(
    action: string,
    field: string,
    wanted: string | number,
    requiresOn: boolean,
    sendFn: () => Promise<boolean>,
  ): Promise<void> {
    if (!this.cloudClient) {
      throw new Error('Cloud client is not configured');
    }
    if (!this.state.online || this.state.stale) {
      throw new Error('ALORAIR cloud status is stale or unavailable; waiting for fresh telemetry');
    }
    const existingPending = this.pending.get(field);
    if (existingPending && existingPending.deadlineMs > Date.now() && existingPending.wanted === wanted) {
      return;
    }
    if (requiresOn && this.state.power !== true) {
      throw new Error('Turn the dehumidifier on before changing this setting');
    }
    if (!(field === 'powerStatus' && wanted === '00') && this.state.faultCodes.length > 0) {
      throw new Error(`Resolve dehumidifier fault (${this.state.faultCodes.join(', ')}) before sending commands`);
    }

    const now = Date.now();
    const deadlineMs = now + PENDING_COMMAND_SECONDS * 1000;
    const baselineMs = parseVendorTimestampMs(this.state.sampleTimestampIso);

    this.pending.set(field, {
      wanted,
      deadlineMs,
      issuedAtMs: now,
      baselineSampleMs: baselineMs,
    });

    const feedback: CommandFeedback = {
      action,
      status: 'awaiting_feedback',
      issuedAtIso: new Date(now).toISOString(),
      deadlineMs,
      field,
      requestedValue: wanted,
      acknowledged: false,
    };
    this.state.lastCommand = feedback;
    this.emitState();

    try {
      const sent = await sendFn();
      if (!sent) {
        this.pending.delete(field);
        return;
      }
      feedback.acknowledged = true;
      await this.refreshCloud().catch(() => undefined);
    } catch (err) {
      if (err instanceof CannotConnectError || (err instanceof CommandError && err.outcomeUnknown)) {
        feedback.status = 'delivery_uncertain';
        await this.refreshCloud().catch(() => undefined);
        this.emitState();
        throw new Error('Command delivery is uncertain; checking fresh device telemetry before retrying', { cause: err });
      }
      if (err instanceof AuthenticationError) {
        feedback.status = 'rejected';
        this.pending.delete(field);
        this.emitState();
        throw new Error('ALORAIR cloud authentication failed; check your email and password', { cause: err });
      }
      feedback.status = 'rejected';
      this.pending.delete(field);
      this.emitState();
      throw err;
    }
  }

  private async executeLocalCommand(
    action: string,
    field: string,
    wanted: string | number,
    sendFn: () => Promise<LocalStatusReport | null>,
  ): Promise<void> {
    const existingPending = this.pending.get(field);
    if (existingPending && existingPending.deadlineMs > Date.now() && existingPending.wanted === wanted) {
      throw new Error(
        'Previous local command delivery is still uncertain; waiting for pending window to expire before retrying.',
      );
    }

    const now = Date.now();
    const deadlineMs = now + PENDING_COMMAND_SECONDS * 1000;
    this.pending.set(field, {
      wanted,
      deadlineMs,
      issuedAtMs: now,
      baselineSampleMs: null,
    });

    const feedback: CommandFeedback = {
      action,
      status: 'awaiting_feedback',
      issuedAtIso: new Date(now).toISOString(),
      deadlineMs,
      field,
      requestedValue: wanted,
      acknowledged: false,
    };
    this.state.lastCommand = feedback;
    this.emitState();

    try {
      const report = await sendFn();
      this.pending.delete(field);
      if (report) {
        feedback.acknowledged = true;
        feedback.status = 'device_reported';
        feedback.reportedAtIso = report.receivedAtIso;
        this.applyLocalStatusReport(report);
      }
    } catch (err) {
      if (err instanceof LocalCommandUncertainError) {
        feedback.status = 'delivery_uncertain';
        this.emitState();
        throw new Error('Local command delivery is uncertain; no automatic retry was sent', { cause: err });
      }
      feedback.status = 'rejected';
      this.pending.delete(field);
      this.emitState();
      throw err;
    }
  }
}

