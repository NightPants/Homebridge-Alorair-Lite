import type {
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from 'homebridge';

import type { AlorairDeviceCoordinator } from './coordinator.js';
import { sanitizeHomeKitFirmwareVersion } from './models.js';
import type { AlorairLitePlatform } from './platform.js';
import {
  CONTINUOUS_HUMIDITY_SENTINEL,
  HUMIDITY_STEP,
  LOW_FILTER_LIFE_THRESHOLD,
  MAX_AUTO_HUMIDITY,
  MIN_AUTO_HUMIDITY,
} from './settings.js';
import type { AlorairAccessoryContext, AlorairDeviceState } from './types.js';

export class AlorairPlatformAccessory {
  private primaryService?: Service;
  private inletTempService?: Service;
  private inletHumidityService?: Service;
  private filterService?: Service;
  private unsubscribe?: () => void;
  private revertTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly platform: AlorairLitePlatform,
    private readonly accessory: PlatformAccessory<AlorairAccessoryContext>,
    private readonly coordinator: AlorairDeviceCoordinator,
  ) {
    const ctx = this.accessory.context;
    const state = this.coordinator.getState();

    this.updateAccessoryInfo(
      ctx.displayName,
      state.model || ctx.model || 'AlorAir-Lite Dehumidifier',
      ctx.mac,
      state.firmwareVersion || ctx.firmwareVersion || '1.0.0',
    );

    switch (ctx.role) {
      case 'main':
        this.setupMainDehumidifier();
        break;
      case 'inletHumidity':
        this.setupInletHumiditySensor();
        break;
      case 'inletTemperature':
        this.setupInletTemperatureSensor();
        break;
      case 'continuousSwitch':
        this.setupContinuousSwitch();
        break;
      case 'purgeSwitch':
        this.setupPurgeSwitch();
        break;
      case 'locateSwitch':
        this.setupLocateSwitch();
        break;
      case 'problemSensor':
        this.setupProblemSensor();
        break;
      case 'drainingSensor':
        this.setupDrainingSensor();
        break;
      case 'outletTemperature':
        this.setupOutletTemperatureSensor();
        break;
      case 'outletHumidity':
        this.setupOutletHumiditySensor();
        break;
    }

    this.unsubscribe = this.coordinator.onStateUpdate((nextState) => {
      this.applyStateUpdate(nextState);
    });

    this.applyStateUpdate(state);
  }

  public dispose(): void {
    this.unsubscribe?.();
    if (this.revertTimer) {
      clearTimeout(this.revertTimer);
      this.revertTimer = undefined;
    }
  }

  private updateAccessoryInfo(
    displayName: string,
    model: string,
    serialNumber: string,
    firmwareVersion: string,
  ): void {
    const info = this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?? this.accessory.addService(this.platform.Service.AccessoryInformation);

    info
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'ALORAIR')
      .setCharacteristic(this.platform.Characteristic.Model, model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, serialNumber)
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        sanitizeHomeKitFirmwareVersion(firmwareVersion),
      )
      .setCharacteristic(this.platform.Characteristic.Name, displayName);
  }

  private configureServiceName(service: Service, name: string): void {
    service.setCharacteristic(this.platform.Characteristic.Name, name);
    if (this.platform.Characteristic.ConfiguredName) {
      if (!service.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
        service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
      }
      if (!service.getCharacteristic(this.platform.Characteristic.ConfiguredName).value) {
        service.updateCharacteristic(this.platform.Characteristic.ConfiguredName, name);
      }
    }
  }

  private hapCommunicationFailure(err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err);
    this.platform.log.warn(`[${this.accessory.context.displayName}] Command rejected: ${message}`);
    return new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }

  private setupMainDehumidifier(): void {
    const { Service, Characteristic } = this.platform;
    const displayName = this.accessory.context.displayName;

    const dehum = this.accessory.getService(Service.HumidifierDehumidifier)
      ?? this.accessory.addService(Service.HumidifierDehumidifier, displayName);
    this.configureServiceName(dehum, displayName);

    dehum.getCharacteristic(Characteristic.Active)
      .onGet(() => {
        const st = this.coordinator.getState();
        return st.power === true ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
      })
      .onSet(async (value: CharacteristicValue) => {
        const targetOn = value === Characteristic.Active.ACTIVE || value === 1 || value === true;
        try {
          await this.coordinator.setPower(targetOn);
        } catch (err) {
          throw this.hapCommunicationFailure(err);
        }
      });

    dehum.getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState)
      .setProps({
        validValues: [
          Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
          Characteristic.CurrentHumidifierDehumidifierState.IDLE,
          Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING,
        ],
      })
      .onGet(() => this.computeCurrentHomeKitDehumidifierState(this.coordinator.getState()));

    const targetStateChar = dehum.getCharacteristic(Characteristic.TargetHumidifierDehumidifierState);
    targetStateChar
      .updateValue(Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER)
      .setProps({
        validValues: [Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER],
      })
      .onGet(() => Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER)
      .onSet(async () => {
        // Dehumidifier-only hardware; nothing to switch.
      });

    dehum.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => {
        const st = this.coordinator.getState();
        return st.inletHumidity ?? 50;
      });

    const thresholdChar = dehum.getCharacteristic(Characteristic.RelativeHumidityDehumidifierThreshold);
    const currentThreshold = Number(thresholdChar.value ?? 0);
    if (currentThreshold < CONTINUOUS_HUMIDITY_SENTINEL || currentThreshold > MAX_AUTO_HUMIDITY) {
      thresholdChar.updateValue(this.computeThresholdCharacteristicValue(this.coordinator.getState()));
    }
    // iOS Home's small tile subtitle computes (value - minValue) / (maxValue - minValue) * 100
    // (e.g. 30% with minValue=20, maxValue=80 shows "Lowering to 17%"), so expose the full
    // 0..100 HAP range and let normalizeHomeKitThresholdToTarget clamp <=22 -> 20 (CO) and 25..80.
    thresholdChar
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: HUMIDITY_STEP,
      })
      .onGet(() => this.computeThresholdCharacteristicValue(this.coordinator.getState()))
      .onSet(async (value: CharacteristicValue) => {
        try {
          await this.coordinator.setDehumidifierThreshold(Number(value));
        } catch (err) {
          throw this.hapCommunicationFailure(err);
        }
      });

    this.primaryService = dehum;

    if (this.platform.config.linkInletSensorsToDehumidifier === true) {
      if (this.platform.config.exposeInletTemperature !== false) {
        const tempName = `${displayName} Intake Temperature`;
        const tempSvc = this.accessory.getServiceById(Service.TemperatureSensor, 'inlet-temp')
          ?? this.accessory.addService(Service.TemperatureSensor, tempName, 'inlet-temp');
        this.configureServiceName(tempSvc, tempName);
        tempSvc.getCharacteristic(Characteristic.CurrentTemperature)
          .setProps({ minValue: -50, maxValue: 100 })
          .onGet(() => this.coordinator.getState().inletCelsius ?? 20);
        dehum.addLinkedService(tempSvc);
        this.inletTempService = tempSvc;
      } else {
        const staleTemp = this.accessory.getServiceById(Service.TemperatureSensor, 'inlet-temp');
        if (staleTemp) {
          this.accessory.removeService(staleTemp);
        }
      }

      if (this.platform.config.exposeInletHumidity !== false) {
        const humName = `${displayName} Intake Humidity`;
        const humSvc = this.accessory.getServiceById(Service.HumiditySensor, 'inlet-humidity')
          ?? this.accessory.addService(Service.HumiditySensor, humName, 'inlet-humidity');
        this.configureServiceName(humSvc, humName);
        humSvc.getCharacteristic(Characteristic.CurrentRelativeHumidity)
          .onGet(() => this.coordinator.getState().inletHumidity ?? 50);
        dehum.addLinkedService(humSvc);
        this.inletHumidityService = humSvc;
      } else {
        const staleHum = this.accessory.getServiceById(Service.HumiditySensor, 'inlet-humidity');
        if (staleHum) {
          this.accessory.removeService(staleHum);
        }
      }
    } else {
      const staleTemp = this.accessory.getServiceById(Service.TemperatureSensor, 'inlet-temp');
      if (staleTemp) {
        this.accessory.removeService(staleTemp);
      }
      const staleHum = this.accessory.getServiceById(Service.HumiditySensor, 'inlet-humidity');
      if (staleHum) {
        this.accessory.removeService(staleHum);
      }
    }

    this.ensureFilterServiceIfAvailable(this.coordinator.getState());
  }

  private ensureFilterServiceIfAvailable(state: AlorairDeviceState): void {
    const { Service, Characteristic } = this.platform;
    if (state.filters.length === 0 && !this.filterService) {
      const cached = this.accessory.getService(Service.FilterMaintenance);
      if (!cached) {
        return;
      }
      this.filterService = cached;
    }

    if (!this.filterService && state.filters.length > 0) {
      const filterName = `${this.accessory.context.displayName} Filter`;
      const svc = this.accessory.getService(Service.FilterMaintenance)
        ?? this.accessory.addService(Service.FilterMaintenance, filterName);
      this.configureServiceName(svc, filterName);

      svc.getCharacteristic(Characteristic.FilterLifeLevel)
        .onGet(() => {
          const f = this.coordinator.getState().filters[0];
          return f ? Math.round(Math.min(100, Math.max(0, f.remainingPercent))) : 100;
        });

      svc.getCharacteristic(Characteristic.FilterChangeIndication)
        .onGet(() => this.computeFilterChangeIndication(this.coordinator.getState()));

      if (this.coordinator.transport === 'cloud') {
        svc.getCharacteristic(Characteristic.ResetFilterIndication)
          .onSet(async () => {
            try {
              await this.coordinator.resetFilter();
            } catch (err) {
              throw this.hapCommunicationFailure(err);
            }
          });
      }

      if (this.primaryService) {
        this.primaryService.addLinkedService(svc);
      }
      this.filterService = svc;
    }
  }

  private setupContinuousSwitch(): void {
    const { Service, Characteristic } = this.platform;
    const sw = this.accessory.getService(Service.Switch)
      ?? this.accessory.addService(Service.Switch, this.accessory.context.displayName);
    this.configureServiceName(sw, this.accessory.context.displayName);

    sw.getCharacteristic(Characteristic.On)
      .onGet(() => this.coordinator.getState().mode === 'continuous')
      .onSet(async (value: CharacteristicValue) => {
        try {
          await this.coordinator.setContinuousMode(Boolean(value));
        } catch (err) {
          throw this.hapCommunicationFailure(err);
        }
      });

    this.primaryService = sw;
  }

  private setupPurgeSwitch(): void {
    const { Service, Characteristic } = this.platform;
    const sw = this.accessory.getService(Service.Switch)
      ?? this.accessory.addService(Service.Switch, this.accessory.context.displayName);
    this.configureServiceName(sw, this.accessory.context.displayName);

    sw.getCharacteristic(Characteristic.On)
      .onGet(() => this.coordinator.getState().draining === true)
      .onSet(async (value: CharacteristicValue) => {
        if (!value) {
          // AlorAir-Lite protocol has no cancel-purge opcode; reflect real draining state shortly.
          if (this.revertTimer) {
            clearTimeout(this.revertTimer);
          }
          this.revertTimer = setTimeout(() => {
            sw.updateCharacteristic(Characteristic.On, this.coordinator.getState().draining === true);
          }, 250);
          return;
        }
        try {
          await this.coordinator.purge();
        } catch (err) {
          throw this.hapCommunicationFailure(err);
        }
      });

    this.primaryService = sw;
  }

  private setupLocateSwitch(): void {
    const { Service, Characteristic } = this.platform;
    const sw = this.accessory.getService(Service.Switch)
      ?? this.accessory.addService(Service.Switch, this.accessory.context.displayName);
    this.configureServiceName(sw, this.accessory.context.displayName);

    sw.getCharacteristic(Characteristic.On)
      .onGet(() => this.coordinator.getState().locating === true)
      .onSet(async (value: CharacteristicValue) => {
        try {
          await this.coordinator.setLocate(Boolean(value));
        } catch (err) {
          throw this.hapCommunicationFailure(err);
        }
      });

    this.primaryService = sw;
  }

  private setupProblemSensor(): void {
    const { Service, Characteristic } = this.platform;
    const sensor = this.accessory.getService(Service.ContactSensor)
      ?? this.accessory.addService(Service.ContactSensor, this.accessory.context.displayName);
    this.configureServiceName(sensor, this.accessory.context.displayName);

    sensor.getCharacteristic(Characteristic.ContactSensorState)
      .onGet(() => (
        this.coordinator.getState().faultCodes.length > 0
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED
      ));

    this.primaryService = sensor;
  }

  private setupDrainingSensor(): void {
    const { Service, Characteristic } = this.platform;
    const sensor = this.accessory.getService(Service.OccupancySensor)
      ?? this.accessory.addService(Service.OccupancySensor, this.accessory.context.displayName);
    this.configureServiceName(sensor, this.accessory.context.displayName);

    sensor.getCharacteristic(Characteristic.OccupancyDetected)
      .onGet(() => (
        this.coordinator.getState().draining === true
          ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED
      ));

    this.primaryService = sensor;
  }

  private setupInletTemperatureSensor(): void {
    const { Service, Characteristic } = this.platform;
    const sensor = this.accessory.getService(Service.TemperatureSensor)
      ?? this.accessory.addService(Service.TemperatureSensor, this.accessory.context.displayName);
    this.configureServiceName(sensor, this.accessory.context.displayName);

    sensor.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100 })
      .onGet(() => this.coordinator.getState().inletCelsius ?? 20);

    this.primaryService = sensor;
  }

  private setupInletHumiditySensor(): void {
    const { Service, Characteristic } = this.platform;
    const sensor = this.accessory.getService(Service.HumiditySensor)
      ?? this.accessory.addService(Service.HumiditySensor, this.accessory.context.displayName);
    this.configureServiceName(sensor, this.accessory.context.displayName);

    sensor.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.coordinator.getState().inletHumidity ?? 50);

    this.primaryService = sensor;
  }

  private setupOutletTemperatureSensor(): void {
    const { Service, Characteristic } = this.platform;
    const sensor = this.accessory.getService(Service.TemperatureSensor)
      ?? this.accessory.addService(Service.TemperatureSensor, this.accessory.context.displayName);
    this.configureServiceName(sensor, this.accessory.context.displayName);

    sensor.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100 })
      .onGet(() => this.coordinator.getState().outletCelsius ?? 20);

    this.primaryService = sensor;
  }

  private setupOutletHumiditySensor(): void {
    const { Service, Characteristic } = this.platform;
    const sensor = this.accessory.getService(Service.HumiditySensor)
      ?? this.accessory.addService(Service.HumiditySensor, this.accessory.context.displayName);
    this.configureServiceName(sensor, this.accessory.context.displayName);

    sensor.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.coordinator.getState().outletHumidity ?? 50);

    this.primaryService = sensor;
  }

  private computeCurrentHomeKitDehumidifierState(state: AlorairDeviceState): number {
    const { Characteristic } = this.platform;
    if (!state.online || state.power !== true) {
      return Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
    }
    if (this.platform.config.dehumidifierIdleDisplayMode === 'active') {
      return Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING;
    }
    if (state.compressorActive === false || state.targetReachedIdle) {
      return Characteristic.CurrentHumidifierDehumidifierState.IDLE;
    }
    return Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING;
  }

  private computeThresholdCharacteristicValue(state: AlorairDeviceState): number {
    if (state.mode === 'continuous') {
      return CONTINUOUS_HUMIDITY_SENTINEL;
    }
    const target = state.targetHumidity ?? state.lastAutoHumidity;
    return Math.min(MAX_AUTO_HUMIDITY, Math.max(MIN_AUTO_HUMIDITY, target));
  }

  private computeFilterChangeIndication(state: AlorairDeviceState): number {
    const { Characteristic } = this.platform;
    const threshold = this.platform.config.lowFilterThreshold ?? LOW_FILTER_LIFE_THRESHOLD;
    const primaryFilter = state.filters[0];
    if (primaryFilter && primaryFilter.remainingPercent <= threshold) {
      return Characteristic.FilterChangeIndication.CHANGE_FILTER;
    }
    return Characteristic.FilterChangeIndication.FILTER_OK;
  }

  public applyStateUpdate(state: AlorairDeviceState): void {
    const { Characteristic } = this.platform;
    const ctx = this.accessory.context;
    const hasFault = state.faultCodes.length > 0 ? 1 : 0;

    switch (ctx.role) {
      case 'main': {
        this.updateAccessoryInfo(
          ctx.displayName,
          state.model || ctx.model,
          ctx.mac,
          state.firmwareVersion || ctx.firmwareVersion,
        );
        if (this.primaryService) {
          this.primaryService.updateCharacteristic(
            Characteristic.Active,
            state.power === true ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
          );
          this.primaryService.updateCharacteristic(
            Characteristic.CurrentHumidifierDehumidifierState,
            this.computeCurrentHomeKitDehumidifierState(state),
          );
          this.primaryService.updateCharacteristic(
            Characteristic.TargetHumidifierDehumidifierState,
            Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
          );
          if (state.inletHumidity !== null) {
            this.primaryService.updateCharacteristic(
              Characteristic.CurrentRelativeHumidity,
              state.inletHumidity,
            );
          }
          this.primaryService.updateCharacteristic(
            Characteristic.RelativeHumidityDehumidifierThreshold,
            this.computeThresholdCharacteristicValue(state),
          );
        }

        if (this.inletTempService && state.inletCelsius !== null) {
          this.inletTempService.updateCharacteristic(
            Characteristic.CurrentTemperature,
            state.inletCelsius,
          );
        }

        if (this.inletHumidityService && state.inletHumidity !== null) {
          this.inletHumidityService.updateCharacteristic(
            Characteristic.CurrentRelativeHumidity,
            state.inletHumidity,
          );
        }

        this.ensureFilterServiceIfAvailable(state);
        if (this.filterService && state.filters.length > 0) {
          this.filterService.updateCharacteristic(
            Characteristic.FilterLifeLevel,
            Math.round(Math.min(100, Math.max(0, state.filters[0].remainingPercent))),
          );
          this.filterService.updateCharacteristic(
            Characteristic.FilterChangeIndication,
            this.computeFilterChangeIndication(state),
          );
        }
        break;
      }

      case 'inletTemperature':
        if (state.inletCelsius !== null) {
          this.primaryService?.updateCharacteristic(Characteristic.CurrentTemperature, state.inletCelsius);
        }
        break;

      case 'inletHumidity':
        if (state.inletHumidity !== null) {
          this.primaryService?.updateCharacteristic(Characteristic.CurrentRelativeHumidity, state.inletHumidity);
        }
        break;

      case 'continuousSwitch':
        this.primaryService?.updateCharacteristic(Characteristic.On, state.mode === 'continuous');
        break;

      case 'purgeSwitch':
        this.primaryService?.updateCharacteristic(Characteristic.On, state.draining === true);
        break;

      case 'locateSwitch':
        this.primaryService?.updateCharacteristic(Characteristic.On, state.locating === true);
        break;

      case 'problemSensor':
        this.primaryService?.updateCharacteristic(
          Characteristic.ContactSensorState,
          hasFault
            ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : Characteristic.ContactSensorState.CONTACT_DETECTED,
        );
        this.primaryService?.updateCharacteristic(Characteristic.StatusFault, hasFault);
        break;

      case 'drainingSensor':
        this.primaryService?.updateCharacteristic(
          Characteristic.OccupancyDetected,
          state.draining === true
            ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
            : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
        );
        break;

      case 'outletTemperature':
        if (state.outletCelsius !== null) {
          this.primaryService?.updateCharacteristic(Characteristic.CurrentTemperature, state.outletCelsius);
        }
        break;

      case 'outletHumidity':
        if (state.outletHumidity !== null) {
          this.primaryService?.updateCharacteristic(Characteristic.CurrentRelativeHumidity, state.outletHumidity);
        }
        break;
    }
  }
}

