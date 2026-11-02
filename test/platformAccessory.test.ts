import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Accessory,
  Characteristic,
  HAPStatus,
  HapStatusError,
  Service,
  uuid,
} from '@homebridge/hap-nodejs';
import type { API, Logging, PlatformAccessory } from 'homebridge';

import type { AlorairCloudClient, SanitizedCloudDevice } from '../src/cloudApi.js';
import { AlorairDeviceCoordinator } from '../src/coordinator.js';
import { AlorairPlatformAccessory } from '../src/platformAccessory.js';
import type { AlorairLitePlatform } from '../src/platform.js';
import type { AlorairAccessoryContext } from '../src/types.js';

function createSilentLogger(): Logging {
  const noop = () => undefined;
  const log = Object.assign(noop, {
    info: noop,
    success: noop,
    warn: noop,
    error: noop,
    debug: noop,
    log: noop,
  });
  return log as unknown as Logging;
}

function createFakePlatformAccessory(context: AlorairAccessoryContext): PlatformAccessory<AlorairAccessoryContext> {
  const hapAcc = new Accessory(context.displayName, uuid.generate(`test:${context.mac}:${context.role}`));
  const wrapper = {
    displayName: context.displayName,
    UUID: hapAcc.UUID,
    context,
    services: hapAcc.services,
    addService: (...args: Parameters<Accessory['addService']>) => hapAcc.addService(...args),
    getService: (...args: Parameters<Accessory['getService']>) => hapAcc.getService(...args),
    getServiceById: (...args: Parameters<Accessory['getServiceById']>) => hapAcc.getServiceById(...args),
    removeService: (...args: Parameters<Accessory['removeService']>) => hapAcc.removeService(...args),
  };
  return wrapper as unknown as PlatformAccessory<AlorairAccessoryContext>;
}

describe('AlorairDeviceCoordinator & AlorairPlatformAccessory (HomeKit HAP)', () => {
  it('maps HumidifierDehumidifier, linked Temperature & Filter services, Continuous switch, and Problem sensor', async () => {
    const calls: Array<{ fn: string; arg: unknown }> = [];
    let currentPower = '01';
    let currentTarget = 50;
    let currentErr = '00';

    const makeSnapshot = (): SanitizedCloudDevice => ({
      id: 'dev_1',
      mac: 'AABBCC112233',
      deviceNum: '000000000000AABBCC112233',
      observedAtUtc: new Date().toISOString(),
      fields: {
        name: 'Basement Storm LGR',
        productName: 'Storm LGR Extreme',
        firmwareVersion: '2.1.0',
        powerStatus: currentPower,
        drainStatus: '00',
        errCode: currentErr,
        currentHumidity: currentTarget,
        inHumidity: 59,
        outHumidity: 35,
        inCelsius: 19.5,
        outCelsius: 24.5,
        updateTimeStr: new Date().toISOString().slice(0, 19).replace('T', ' '),
      },
      filters: [
        {
          filterId: 'flt_main',
          recommendedHours: 1000,
          usedHours: 920,
          extensionHours: 0,
          remainingHours: 80,
          remainingDays: 3.33,
          remainingPercent: 8,
        },
      ],
    });

    const fakeCloud = {
      getStatus: async () => makeSnapshot(),
      setPower: async (_mac: string, on: boolean) => {
        calls.push({ fn: 'setPower', arg: on });
        currentPower = on ? '01' : '00';
      },
      setHumidity: async (_mac: string, target: number) => {
        calls.push({ fn: 'setHumidity', arg: target });
        currentTarget = target;
      },
      purge: async () => {
        calls.push({ fn: 'purge', arg: true });
      },
      resetFilter: async () => {
        calls.push({ fn: 'resetFilter', arg: true });
      },
    } as unknown as AlorairCloudClient;

    const log = createSilentLogger();
    const coordinator = new AlorairDeviceCoordinator({
      mac: 'AABBCC112233',
      transport: 'cloud',
      cloudClient: fakeCloud,
      enforceCompressorRestartDelay: true,
      log,
    });

    coordinator.applyCloudDeviceSnapshot(makeSnapshot());

    const fakePlatform = {
      Service,
      Characteristic,
      log,
      config: {
        platform: 'AlorairLite',
        lowFilterThreshold: 10,
      },
      api: {
        hap: {
          Service,
          Characteristic,
          HAPStatus,
          HapStatusError,
        },
      } as unknown as API,
    } as unknown as AlorairLitePlatform;

    const mainAcc = createFakePlatformAccessory({
      mac: 'AABBCC112233',
      role: 'main',
      displayName: 'Basement Storm LGR',
      model: 'Storm LGR Extreme',
      firmwareVersion: '2.1.0',
    });
    const contAcc = createFakePlatformAccessory({
      mac: 'AABBCC112233',
      role: 'continuousSwitch',
      displayName: 'Basement Storm LGR Continuous Mode',
      model: 'Storm LGR Extreme',
      firmwareVersion: '2.1.0',
    });
    const probAcc = createFakePlatformAccessory({
      mac: 'AABBCC112233',
      role: 'problemSensor',
      displayName: 'Basement Storm LGR Problem Alert',
      model: 'Storm LGR Extreme',
      firmwareVersion: '2.1.0',
    });

    const mainHandler = new AlorairPlatformAccessory(fakePlatform, mainAcc, coordinator);
    const contHandler = new AlorairPlatformAccessory(fakePlatform, contAcc, coordinator);
    const probHandler = new AlorairPlatformAccessory(fakePlatform, probAcc, coordinator);

    try {
      const dehumSvc = mainAcc.getService(Service.HumidifierDehumidifier);
      assert.ok(dehumSvc);
      assert.equal(dehumSvc.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE);
      assert.equal(
        dehumSvc.getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState).value,
        Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING,
      );
      assert.equal(dehumSvc.getCharacteristic(Characteristic.CurrentRelativeHumidity).value, 59);
      assert.equal(dehumSvc.getCharacteristic(Characteristic.RelativeHumidityDehumidifierThreshold).value, 50);

      // Linked intake temperature & filter services
      const tempSvc = mainAcc.getServiceById(Service.TemperatureSensor, 'inlet-temp');
      assert.ok(tempSvc);
      assert.equal(tempSvc.getCharacteristic(Characteristic.CurrentTemperature).value, 19.5);

      const filterSvc = mainAcc.getService(Service.FilterMaintenance);
      assert.ok(filterSvc);
      assert.equal(filterSvc.getCharacteristic(Characteristic.FilterLifeLevel).value, 8);
      assert.equal(
        filterSvc.getCharacteristic(Characteristic.FilterChangeIndication).value,
        Characteristic.FilterChangeIndication.CHANGE_FILTER,
      );

      // Toggle Continuous Mode switch ON -> sets target 20 ("CO")
      await coordinator.setContinuousMode(true);
      assert.equal(calls.at(-1)?.fn, 'setHumidity');
      assert.equal(calls.at(-1)?.arg, 20);
      assert.equal(
        contAcc.getService(Service.Switch)?.getCharacteristic(Characteristic.On).value,
        true,
      );

      // Fault code E1 triggers ContactSensor OPEN (CONTACT_NOT_DETECTED)
      currentErr = '01';
      coordinator.applyCloudDeviceSnapshot(makeSnapshot());
      assert.equal(
        probAcc.getService(Service.ContactSensor)?.getCharacteristic(Characteristic.ContactSensorState).value,
        Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
      );
      currentErr = '00';
      coordinator.applyCloudDeviceSnapshot(makeSnapshot());

      // Turning power OFF then immediately attempting ON enforces 3-minute compressor restart protection
      await coordinator.setPower(false);
      await assert.rejects(
        () => coordinator.setPower(true),
        /Compressor restart protection active/,
      );
    } finally {
      mainHandler.dispose();
      contHandler.dispose();
      probHandler.dispose();
      coordinator.stop();
    }
  });
});

