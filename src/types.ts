import type { PlatformConfig } from 'homebridge';

export type TransportMode = 'cloud' | 'local';
export type DehumidifierMode = 'auto' | 'continuous';
export type TemperatureDisplayUnit = 'celsius' | 'fahrenheit';
export type MoistureDisplayUnit = 'grains_per_pound' | 'grams_per_kilogram';
export type LocalControllerProfile = 'lite' | 'sentinel' | 'auto';

export type AccessoryRole =
  | 'main'
  | 'inletHumidity'
  | 'inletTemperature'
  | 'continuousSwitch'
  | 'purgeSwitch'
  | 'locateSwitch'
  | 'problemSensor'
  | 'drainingSensor'
  | 'outletTemperature'
  | 'outletHumidity';

export type DehumidifierIdleDisplayMode = 'idle' | 'active';

export interface AlorairPlatformConfig extends PlatformConfig {
  name?: string;
  transport?: TransportMode;

  // Cloud transport settings
  email?: string;
  password?: string;
  allowInsecureHttp?: boolean;
  mac?: string;
  cloudBaseUrl?: string;
  pollIntervalSeconds?: number;

  // Local TCP listener settings
  listenHost?: string;
  listenPort?: number;
  allowedClientIp?: string;
  controllerProfile?: LocalControllerProfile;
  allowLocalPowerOn?: boolean;
  allowExperimentalLocalCommands?: boolean;

  // Safety & behavior settings
  enforceCompressorRestartDelay?: boolean;
  autoPowerOnWhenSettingHumidity?: boolean;
  lowFilterThreshold?: number;

  // HomeKit companion accessories
  exposeInletHumidity?: boolean;
  exposeInletTemperature?: boolean;
  linkInletSensorsToDehumidifier?: boolean;
  dehumidifierIdleDisplayMode?: DehumidifierIdleDisplayMode;
  exposeContinuousSwitch?: boolean;
  exposePurgeSwitch?: boolean;
  exposeLocateSwitch?: boolean;
  exposeProblemSensor?: boolean;
  exposeDrainingSensor?: boolean;
  exposeOutletSensors?: boolean;

  // Built-in Wi-Fi & Device Setup Portal
  enableSetupPortal?: boolean;
  setupPortalHost?: string;
  setupPortalPort?: number;
  setupPortalToken?: string;

  // Diagnostics
  debugLogging?: boolean;
}

export interface AlorairFilterSummary {
  filterId: string;
  recommendedHours: number;
  usedHours: number;
  extensionHours: number;
  remainingHours: number;
  remainingDays: number;
  remainingPercent: number;
}

export type CommandFeedbackStatus =
  | 'none'
  | 'awaiting_feedback'
  | 'device_reported'
  | 'cloud_acknowledged'
  | 'not_observed'
  | 'delivery_uncertain'
  | 'rejected';

export interface CommandFeedback {
  action: string;
  status: CommandFeedbackStatus;
  issuedAtIso: string;
  deadlineMs: number;
  field?: string;
  requestedValue?: string | number | boolean;
  acknowledged: boolean;
  reportedAtIso?: string;
}

export interface AlorairDeviceState {
  mac: string;
  deviceNum: string;
  deviceId?: string;
  name: string;
  model: string;
  firmwareVersion: string;
  hardwareVersion?: string;
  transport: TransportMode;
  online: boolean;
  stale: boolean;

  power: boolean | null;
  targetReachedIdle: boolean;
  mode: DehumidifierMode | null;
  targetHumidity: number | null;
  lastAutoHumidity: number;

  inletHumidity: number | null;
  outletHumidity: number | null;
  inletCelsius: number | null;
  outletCelsius: number | null;
  inletGrainsPerPound: number | null;
  outletGrainsPerPound: number | null;
  inletGramsPerKilogram: number | null;
  outletGramsPerKilogram: number | null;
  coilTemperature: number | null;

  draining: boolean | null;
  defrosting: boolean | null;
  locating: boolean | null;
  compressorActive: boolean | null;
  fanActive: boolean | null;

  temperatureUnit: TemperatureDisplayUnit | null;
  moistureUnit: MoistureDisplayUnit | null;
  workingHours: number | null;

  rawErrorMask: string | null;
  faultCodes: string[];
  filters: AlorairFilterSummary[];

  sampleTimestampIso: string | null;
  observedAtIso: string | null;
  pendingPower: 'on' | 'off' | null;
  restartDelayRemainingSeconds: number;
  lastCommand: CommandFeedback | null;
}

export interface AlorairAccessoryContext {
  mac: string;
  role: AccessoryRole;
  displayName: string;
  model: string;
  firmwareVersion: string;
}

export interface HiflyingDiscoveredModule {
  ip: string;
  mac: string;
  modelId: string;
  raw: string;
}

export interface HiflyingWifiSite {
  channel: string;
  ssid: string;
  bssid: string;
  security: string;
  signalPercent: number;
}

export interface WifiProvisionOptions {
  targetIp?: string;
  udpPort?: number;
  ssid: string;
  password: string;
  securityMode?: 'WPA2PSK' | 'WPAPSK' | 'OPEN';
  cipher?: 'AES' | 'TKIP' | 'NONE';
  redirectTcpServer?: {
    host: string;
    port: number;
  };
  rebootAfterSave?: boolean;
  timeoutMs?: number;
}

export interface WifiProvisionResult {
  success: boolean;
  moduleInfo?: HiflyingDiscoveredModule;
  steps: Array<{ command: string; response: string }>;
  error?: string;
}

