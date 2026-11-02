export const PLATFORM_NAME = 'AlorairLite';
export const PLUGIN_NAME = 'homebridge-alorair-lite';

export const DEFAULT_CLOUD_BASE_URL = 'http://online-app1.toovem.com:8081/rest/api/';

export const ALORAIR_LITE_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC2wuZQGoCioJg4RZjzTmyeGqGLrjP4',
  'jR7AF85d7j/jhghoRZeFatM+V5WkvS6irQ2Q7v4DFW+4oLYUbDuTQAgUn+Bbo/MnSaY',
  'LI9WssM+W6j5mrxd8ca+PRoRF+pPQzIpMAjwDdY+pPi6l/AzEiRBurguAYve8kBKe8l',
  'ActVS+mwIDAQAB',
  '-----END PUBLIC KEY-----',
].join('\n');

export const DEFAULT_LOCAL_LISTEN_HOST = '0.0.0.0';
export const DEFAULT_LOCAL_PORT = 6100;
export const DEFAULT_SENTINEL_PORT = 6200;
export const DEFAULT_POLL_INTERVAL_SECONDS = 30;
export const DEFAULT_SETUP_PORTAL_HOST = '127.0.0.1';
export const DEFAULT_SETUP_PORTAL_PORT = 8589;

export const MINIMUM_OFF_SECONDS = 180;
export const PENDING_COMMAND_SECONDS = 300;
export const CLOUD_STALE_SECONDS = 300;
export const CLOUD_FUTURE_SKEW_SECONDS = 60;
export const LOCAL_STALE_SECONDS = 35;

export const CONTINUOUS_HUMIDITY_SENTINEL = 20;
export const MIN_AUTO_HUMIDITY = 25;
export const MAX_AUTO_HUMIDITY = 80;
export const HUMIDITY_STEP = 5;
export const DEFAULT_AUTO_HUMIDITY = 50;
export const LOW_FILTER_LIFE_THRESHOLD = 15;

export const HIFLYING_ASSIST_KEY = 'HF-A11ASSISTHREAD';
export const HIFLYING_UDP_PORT = 48899;
export const HIFLYING_DEFAULT_AP_IP = '10.10.100.254';

export const BK7231_BLE_SERVICE_UUID = 0xfff0;
export const BK7231_BLE_NOTIFY_UUID = 0xfff1;
export const BK7231_BLE_WRITE_UUID = 0xfff2;
export const BK7231_BLE_DEVICE_PREFIXES = ['bk7231', 'BK-alorair', 'BK-7231', 'BK_', 'alorair'];

