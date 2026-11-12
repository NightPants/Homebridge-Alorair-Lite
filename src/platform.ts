import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';

import {
  AlorairCloudClient,
  AuthenticationError,
  type SanitizedCloudDevice,
} from './cloudApi.js';
import { AlorairDeviceCoordinator } from './coordinator.js';
import { AlorairLocalServer } from './localServer.js';
import { formatMacColon, normalizeMac } from './models.js';
import { AlorairPlatformAccessory } from './platformAccessory.js';
import {
  DEFAULT_CLOUD_BASE_URL,
  DEFAULT_LOCAL_LISTEN_HOST,
  DEFAULT_LOCAL_PORT,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_SETUP_PORTAL_HOST,
  DEFAULT_SETUP_PORTAL_PORT,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './settings.js';
import { AlorairSetupPortal } from './setupServer.js';
import type {
  AccessoryRole,
  AlorairAccessoryContext,
  AlorairPlatformConfig,
  TransportMode,
} from './types.js';

export class AlorairLitePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly config: AlorairPlatformConfig;

  private readonly cachedAccessories = new Map<string, PlatformAccessory<AlorairAccessoryContext>>();
  private readonly activeHandlers = new Map<string, AlorairPlatformAccessory>();
  private readonly coordinators = new Map<string, AlorairDeviceCoordinator>();

  private cloudClient?: AlorairCloudClient;
  private localServer?: AlorairLocalServer;
  private setupPortal?: AlorairSetupPortal;
  private cloudRetryTimer?: ReturnType<typeof setTimeout>;
  private shuttingDown = false;

  constructor(
    public readonly log: Logging,
    config: AlorairPlatformConfig | undefined,
    public readonly api: API,
  ) {
    this.config = config ?? ({ platform: 'AlorairLite' } as AlorairPlatformConfig);
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    if (!config || (!config.transport && !(config.email && config.password) && !config.enableSetupPortal)) {
      this.log.warn(
        'AlorairLite is not configured yet. Open Homebridge Plugin Settings to choose Cloud or Local TCP mode.',
      );
      return;
    }

    this.api.on('didFinishLaunching', () => {
      void this.initializePlatform();
    });

    this.api.on('shutdown', () => {
      void this.shutdownPlatform();
    });
  }

  public configureAccessory(accessory: PlatformAccessory): void {
    const typed = accessory as PlatformAccessory<AlorairAccessoryContext>;
    this.log.info(`Restoring cached accessory from disk: ${typed.displayName}`);
    this.cachedAccessories.set(typed.UUID, typed);
  }

  private resolveTransportMode(): TransportMode {
    if (this.config.transport === 'local') {
      return 'local';
    }
    if (this.config.transport === 'cloud') {
      return 'cloud';
    }
    if (this.config.email && this.config.password) {
      return 'cloud';
    }
    return 'local';
  }

  private async initializePlatform(): Promise<void> {
    if (!this.config.transport && !(this.config.email && this.config.password)) {
      if (this.config.enableSetupPortal) {
        await this.startSetupPortal();
      }
      return;
    }

    const transport = this.resolveTransportMode();
    if (transport === 'local') {
      await this.startLocalTransport();
    } else {
      await this.startCloudTransport();
    }

    if (this.config.enableSetupPortal) {
      await this.startSetupPortal();
    }
  }

  private async startSetupPortal(): Promise<void> {
    try {
      this.setupPortal = new AlorairSetupPortal({
        host: this.config.setupPortalHost ?? DEFAULT_SETUP_PORTAL_HOST,
        port: this.config.setupPortalPort ?? DEFAULT_SETUP_PORTAL_PORT,
        authToken: this.config.setupPortalToken,
        getDevicesSnapshot: () => [...this.coordinators.values()].map((c) => c.getState()),
        onLog: (msg) => this.log.info(`[SetupPortal] ${msg}`),
      });
      const url = await this.setupPortal.start();
      this.log.info(`Wi-Fi Recovery & Setup Wizard available at ${url}`);
    } catch (err) {
      this.log.error(`Failed to start Setup Portal: ${(err as Error).message}`);
    }
  }

  private async startCloudTransport(): Promise<void> {
    const email = this.config.email?.trim();
    const password = this.config.password;
    if (!email || !password) {
      this.log.warn(
        'Cloud transport selected, but email/password are missing. '
        + 'Configure your AlorAir-Lite credentials, switch transport to "local" (zero-cloud TCP), '
        + 'or run "npx homebridge-alorair-lite-setup" to reconnect your dehumidifier to Wi-Fi.',
      );
      return;
    }

    if (this.config.allowInsecureHttp === false) {
      this.log.error(
        'AlorAir-Lite cloud requires HTTP (online-app1.toovem.com:8081). '
        + 'Enable "allowInsecureHttp" in plugin settings or use "local" TCP transport.',
      );
      return;
    }

    try {
      this.cloudClient = new AlorairCloudClient({
        username: email,
        password,
        allowInsecureHttp: true,
        baseUrl: this.config.cloudBaseUrl || DEFAULT_CLOUD_BASE_URL,
      });
    } catch (err) {
      this.log.error(`Cloud client configuration error: ${(err as Error).message}`);
      return;
    }

    // Hydrate cached cloud accessories immediately so HomeKit rooms & automations stay intact during outages.
    this.hydrateCachedDevices('cloud');

    await this.discoverCloudDevicesWithRetry();
  }

  private async discoverCloudDevicesWithRetry(): Promise<void> {
    if (this.shuttingDown || !this.cloudClient) {
      return;
    }

    try {
      const targetMac = this.config.mac?.trim() ? normalizeMac(this.config.mac) : null;
      if (this.config.mac?.trim() && !targetMac) {
        this.log.error(`Invalid MAC address format "${this.config.mac}". Provide 12 hex digits or AA:BB:CC:DD:EE:FF.`);
        return;
      }

      let snapshots: SanitizedCloudDevice[];
      if (targetMac) {
        const single = await this.cloudClient.getStatus(targetMac);
        snapshots = [single];
      } else {
        snapshots = await this.cloudClient.discoverOwnedDevices();
      }

      if (snapshots.length === 0) {
        this.log.warn('Authenticated with AlorAir-Lite Cloud, but no owned dehumidifiers were found on this account.');
        return;
      }

      const activeUuids = new Set<string>();
      for (const snap of snapshots) {
        const name = (typeof snap.fields.name === 'string' && snap.fields.name.trim())
          || (typeof snap.fields.productName === 'string' && snap.fields.productName.trim())
          || `AlorAir ${formatMacColon(snap.mac).slice(-8)}`;
        const model = (typeof snap.fields.productName === 'string' && snap.fields.productName.trim())
          || 'AlorAir-Lite Dehumidifier';
        const fw = (typeof snap.fields.firmwareVersion === 'string' && snap.fields.firmwareVersion.trim())
          || '1.0.0';

        this.log.info(
          `Discovered AlorAir-Lite device: "${name}" (model="${model}", mac=${formatMacColon(snap.mac)})`,
        );

        const coordinator = this.ensureCoordinator(snap.mac, 'cloud', name, model, fw);
        coordinator.applyCloudDeviceSnapshot(snap);
        const uuids = this.syncDeviceAccessories(coordinator, name, model, fw);
        for (const u of uuids) {
          activeUuids.add(u);
        }
      }

      this.pruneStaleAccessories(activeUuids);
    } catch (err) {
      if (err instanceof AuthenticationError) {
        this.log.error(
          `Cloud authentication failed (${err.message}). Stopping automatic login retries to prevent account lockout — `
          + 'verify your email and password in plugin settings and restart Homebridge.',
        );
        for (const coord of this.coordinators.values()) {
          if (coord.transport === 'cloud') {
            coord.stopCloudPolling();
          }
        }
        return;
      }
      this.log.warn(
        `Cloud discovery failed (${(err as Error).message}). Retrying in 60 seconds...`,
      );
      this.cloudRetryTimer = setTimeout(() => {
        void this.discoverCloudDevicesWithRetry();
      }, 60_000);
      this.cloudRetryTimer.unref?.();
    }
  }

  private async startLocalTransport(): Promise<void> {
    const listenHost = this.config.listenHost?.trim() || DEFAULT_LOCAL_LISTEN_HOST;
    const listenPort = this.config.listenPort ?? DEFAULT_LOCAL_PORT;
    const configuredMac = this.config.mac?.trim() ? normalizeMac(this.config.mac) : null;

    if (this.config.mac?.trim() && !configuredMac) {
      this.log.error(`Invalid configured MAC "${this.config.mac}". Use 12 hex digits or AA:BB:CC:DD:EE:FF.`);
      return;
    }

    this.localServer = new AlorairLocalServer({
      listenHost,
      listenPort,
      allowedClientIp: this.config.allowedClientIp,
      mac: configuredMac ?? undefined,
      controllerProfile: this.config.controllerProfile ?? 'auto',
      onConnect: ({ remoteAddress, macHex }) => {
        this.log.info(
          `Local dehumidifier connected! MAC=${formatMacColon(macHex)} (${macHex}) from IP=${remoteAddress}`,
        );
        const displayName = this.resolveLocalDisplayName(macHex, configuredMac);
        const coordinator = this.ensureCoordinator(
          macHex,
          'local',
          displayName,
          'AlorAir-Lite Dehumidifier (Local TCP)',
          '1.0.0',
        );
        this.syncDeviceAccessories(
          coordinator,
          displayName,
          'AlorAir-Lite Dehumidifier (Local TCP)',
          '1.0.0',
        );
      },
      onStatus: (report) => {
        const displayName = this.resolveLocalDisplayName(report.macHex, configuredMac);
        const coordinator = this.ensureCoordinator(
          report.macHex,
          'local',
          displayName,
          report.profile === 'sentinel' ? 'AlorAir Sentinel (Local TCP)' : 'AlorAir-Lite Dehumidifier (Local TCP)',
          '1.0.0',
        );
        coordinator.applyLocalStatusReport(report);
      },
      onDisconnect: ({ sessionId, macHex, reason }) => {
        this.log.warn(`Local dehumidifier session #${sessionId} disconnected (${reason})`);
        if (macHex) {
          const coord = this.coordinators.get(macHex);
          if (coord && coord.transport === 'local') {
            coord.handleLocalDisconnect();
          }
          return;
        }
        for (const coord of this.coordinators.values()) {
          if (coord.transport === 'local') {
            coord.handleLocalDisconnect();
          }
        }
      },
      onFrameLog: (msg) => {
        if (
          this.config.debugLogging
          || msg.startsWith('Invalid')
          || msg.startsWith('Status decode')
          || msg.startsWith('RX unmapped')
          || msg.startsWith('Rejected')
        ) {
          this.log.info(`[LocalTCP] ${msg}`);
        }
      },
    });

    try {
      const bound = await this.localServer.start();
      const companionDesc = bound.companionPorts?.length
        ? ` (and companion ports ${bound.companionPorts.join(', ')})`
        : '';
      this.log.info(
        `Zero-Cloud Local TCP server listening on ${bound.host}:${bound.port}${companionDesc} `
        + `(profile=${this.config.controllerProfile ?? 'auto'}, allowLocalPowerOn=${Boolean(this.config.allowLocalPowerOn)})`,
      );
      if (!configuredMac) {
        this.log.info(
          'Waiting for dehumidifier to connect on LAN (point DNS "online-app.toovem.com" to this Homebridge IP and power-cycle the unit)...',
        );
        this.log.info(
          'Tip: On consumer routers (Verizon Fios, Comcast, ASUS), also override '
          + '"nlb-f2xfnhpq30h62dr13l.us-west-1.nlb.aliyuncsslbintl.com" -> this Homebridge IP to prevent public CNAME leak.',
        );
      }
    } catch (err) {
      this.log.error(`Failed to bind Local TCP listener on ${listenHost}:${listenPort}: ${(err as Error).message}`);
      return;
    }

    if (configuredMac) {
      const displayName = this.config.name?.trim() || `AlorAir ${formatMacColon(configuredMac).slice(-8)}`;
      const coordinator = this.ensureCoordinator(
        configuredMac,
        'local',
        displayName,
        'AlorAir-Lite Dehumidifier (Local TCP)',
        '1.0.0',
      );
      const activeUuids = this.syncDeviceAccessories(
        coordinator,
        displayName,
        'AlorAir-Lite Dehumidifier (Local TCP)',
        '1.0.0',
      );
      this.pruneStaleAccessories(activeUuids);
    } else {
      this.hydrateCachedDevices('local');
    }
  }

  private resolveLocalDisplayName(macHex: string, configuredMac: string | null): string {
    const existing = this.coordinators.get(macHex);
    if (existing) {
      return existing.getState().name;
    }
    const base = this.config.name?.trim() || 'AlorAir';
    if (configuredMac) {
      return base;
    }
    if (this.coordinators.size === 0) {
      return base;
    }
    return `${base} ${macHex.slice(-4)}`;
  }

  private hydrateCachedDevices(transport: TransportMode): void {
    const macs = new Set<string>();
    for (const acc of this.cachedAccessories.values()) {
      if (acc.context?.mac && acc.context.role === 'main') {
        macs.add(acc.context.mac);
      }
    }
    for (const mac of macs) {
      const mainAcc = [...this.cachedAccessories.values()].find(
        (a) => a.context.mac === mac && a.context.role === 'main',
      );
      if (!mainAcc) {
        continue;
      }
      const coord = this.ensureCoordinator(
        mac,
        transport,
        mainAcc.context.displayName,
        mainAcc.context.model,
        mainAcc.context.firmwareVersion,
      );
      this.syncDeviceAccessories(
        coord,
        mainAcc.context.displayName,
        mainAcc.context.model,
        mainAcc.context.firmwareVersion,
      );
    }
  }

  private ensureCoordinator(
    mac: string,
    transport: TransportMode,
    name: string,
    model: string,
    firmwareVersion: string,
  ): AlorairDeviceCoordinator {
    const existing = this.coordinators.get(mac);
    if (existing) {
      return existing;
    }

    const coordinator = new AlorairDeviceCoordinator({
      mac,
      transport,
      cloudClient: this.cloudClient,
      localServer: this.localServer,
      pollIntervalSeconds: this.config.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
      enforceCompressorRestartDelay: this.config.enforceCompressorRestartDelay !== false,
      allowLocalPowerOn: this.config.allowLocalPowerOn === true,
      allowExperimentalLocalCommands: this.config.allowExperimentalLocalCommands === true,
      autoPowerOnWhenSettingHumidity: this.config.autoPowerOnWhenSettingHumidity === true,
      initialName: name,
      initialModel: model,
      initialFirmwareVersion: firmwareVersion,
      log: this.log,
      debugLogging: this.config.debugLogging === true,
    });

    this.coordinators.set(mac, coordinator);
    void coordinator.start();
    return coordinator;
  }

  private getDesiredRoles(transport: TransportMode): Array<{ role: AccessoryRole; suffix: string }> {
    const roles: Array<{ role: AccessoryRole; suffix: string }> = [
      { role: 'main', suffix: '' },
    ];

    if (this.config.exposeSeparateSensorAccessories === true) {
      if (this.config.exposeInletHumidity !== false) {
        roles.push({ role: 'inletHumidity', suffix: 'Humidity' });
      }
      if (this.config.exposeInletTemperature !== false) {
        roles.push({ role: 'inletTemperature', suffix: 'Temperature' });
      }
    }

    if (this.config.exposeContinuousSwitch !== false) {
      roles.push({ role: 'continuousSwitch', suffix: 'Continuous Mode' });
    }

    const purgeSupported = transport === 'cloud' || this.config.allowExperimentalLocalCommands === true;
    if (this.config.exposePurgeSwitch !== false && purgeSupported) {
      roles.push({ role: 'purgeSwitch', suffix: 'Purge Drain' });
    }

    if (this.config.exposeLocateSwitch === true && purgeSupported) {
      roles.push({ role: 'locateSwitch', suffix: 'Locate' });
    }

    if (this.config.exposeProblemSensor !== false && transport === 'cloud') {
      roles.push({ role: 'problemSensor', suffix: 'Problem Alert' });
    }

    if (this.config.exposeDrainingSensor === true) {
      roles.push({ role: 'drainingSensor', suffix: 'Draining' });
    }

    if (this.config.exposeOutletSensors === true) {
      roles.push({ role: 'outletTemperature', suffix: 'Outlet Temperature' });
      roles.push({ role: 'outletHumidity', suffix: 'Outlet Humidity' });
    }

    return roles;
  }

  private syncDeviceAccessories(
    coordinator: AlorairDeviceCoordinator,
    baseName: string,
    model: string,
    firmwareVersion: string,
  ): Set<string> {
    const activeUuids = new Set<string>();
    const roles = this.getDesiredRoles(coordinator.transport);

    for (const { role, suffix } of roles) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${coordinator.mac}:${role}`);
      activeUuids.add(uuid);
      const displayName = suffix ? `${baseName} ${suffix}` : baseName;

      let accessory = this.cachedAccessories.get(uuid);
      if (accessory) {
        accessory.context.mac = coordinator.mac;
        accessory.context.role = role;
        accessory.context.displayName = displayName;
        accessory.context.model = model;
        accessory.context.firmwareVersion = firmwareVersion;
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info(`Registering new HomeKit accessory: ${displayName}`);
        accessory = new this.api.platformAccessory<AlorairAccessoryContext>(displayName, uuid);
        accessory.context = {
          mac: coordinator.mac,
          role,
          displayName,
          model,
          firmwareVersion,
        };
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(uuid, accessory);
      }

      if (!this.activeHandlers.has(uuid)) {
        const handler = new AlorairPlatformAccessory(this, accessory, coordinator);
        this.activeHandlers.set(uuid, handler);
      }
    }

    return activeUuids;
  }

  private pruneStaleAccessories(keepUuids: Set<string>): void {
    for (const [uuid, accessory] of this.cachedAccessories.entries()) {
      if (!keepUuids.has(uuid)) {
        this.log.info(`Removing disabled or stale HomeKit accessory: ${accessory.displayName}`);
        const handler = this.activeHandlers.get(uuid);
        handler?.dispose();
        this.activeHandlers.delete(uuid);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.delete(uuid);
      }
    }
  }

  private async shutdownPlatform(): Promise<void> {
    this.shuttingDown = true;
    if (this.cloudRetryTimer) {
      clearTimeout(this.cloudRetryTimer);
      this.cloudRetryTimer = undefined;
    }
    for (const handler of this.activeHandlers.values()) {
      handler.dispose();
    }
    this.activeHandlers.clear();
    for (const coord of this.coordinators.values()) {
      coord.stop();
    }
    this.coordinators.clear();
    if (this.localServer) {
      await this.localServer.close().catch(() => undefined);
      this.localServer = undefined;
    }
    if (this.setupPortal) {
      await this.setupPortal.close().catch(() => undefined);
      this.setupPortal = undefined;
    }
  }
}

