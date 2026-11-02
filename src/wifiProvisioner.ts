import dgram from 'node:dgram';

import {
  BK7231_BLE_DEVICE_PREFIXES,
  BK7231_BLE_NOTIFY_UUID,
  BK7231_BLE_SERVICE_UUID,
  BK7231_BLE_WRITE_UUID,
  HIFLYING_ASSIST_KEY,
  HIFLYING_DEFAULT_AP_IP,
  HIFLYING_UDP_PORT,
} from './settings.js';
import type {
  HiflyingDiscoveredModule,
  HiflyingWifiSite,
  WifiProvisionOptions,
  WifiProvisionResult,
} from './types.js';

export const BK7231_GATT_PROFILE = {
  serviceUuid16: BK7231_BLE_SERVICE_UUID,
  serviceUuid128: '0000fff0-0000-1000-8000-00805f9b34fb',
  notifyUuid16: BK7231_BLE_NOTIFY_UUID,
  notifyUuid128: '0000fff1-0000-1000-8000-00805f9b34fb',
  writeUuid16: BK7231_BLE_WRITE_UUID,
  writeUuid128: '0000fff2-0000-1000-8000-00805f9b34fb',
  deviceNamePrefixes: BK7231_BLE_DEVICE_PREFIXES,
} as const;

export type BlePayloadFormat = 'json_passwd' | 'json_password' | 'at_wifi';

/**
 * Build candidate BLE Wi-Fi provisioning payloads for Beken BK7231 / FFF2 modules.
 *
 * Static analysis of AlorAir-Lite Android 2.0.8 establishes that the app scans for `bk7231`,
 * subscribes to notifications on 0xFFF1, and writes Wi-Fi credentials to 0xFFF2.
 * Different Beken/Toovem module firmware builds accept JSON (`ssid`/`passwd` or `ssid`/`password`).
 */
export function buildBleWifiCredentialBuffer(
  ssid: string,
  password: string,
  format: BlePayloadFormat = 'json_passwd',
): Buffer {
  if (!ssid || ssid.length > 64) {
    throw new Error('A valid 2.4 GHz Wi-Fi SSID (1-64 characters) is required');
  }
  if (password.length > 64) {
    throw new Error('Wi-Fi password cannot exceed 64 characters');
  }

  switch (format) {
    case 'json_passwd':
      return Buffer.from(JSON.stringify({ ssid, passwd: password }), 'utf8');
    case 'json_password':
      return Buffer.from(JSON.stringify({ ssid, password }), 'utf8');
    case 'at_wifi':
      return Buffer.from(`AT+WJAP=${ssid},${password}\r\n`, 'utf8');
  }
}

/**
 * Split a BLE write payload into MTU-safe chunks (default 20 bytes for standard BLE 4.2 ATT MTU=23).
 */
export function chunkBlePayload(payload: Buffer, chunkSize = 20): Buffer[] {
  if (chunkSize < 1) {
    throw new Error('BLE chunk size must be positive');
  }
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    chunks.push(Buffer.from(payload.subarray(offset, offset + chunkSize)));
  }
  return chunks;
}

/**
 * Parse a notification buffer received on BLE characteristic 0xFFF1 into human-readable diagnostics
 * and extract any reported 12-hex MAC address if present.
 */
export function parseBleNotificationPayload(raw: Buffer): {
  hex: string;
  utf8: string;
  extractedMac: string | null;
} {
  const hex = raw.toString('hex').toUpperCase();
  const utf8 = raw.toString('utf8').replace(/[^\x20-\x7E\r\n\t]/g, '.');
  const colonMacMatch = utf8.match(/(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}/);
  if (colonMacMatch) {
    return {
      hex,
      utf8,
      extractedMac: colonMacMatch[0].replace(/:/g, '').toUpperCase(),
    };
  }
  const plainMacMatch = utf8.match(/\b[0-9A-Fa-f]{12}\b/);
  return {
    hex,
    utf8,
    extractedMac: plainMacMatch ? plainMacMatch[0].toUpperCase() : null,
  };
}

/**
 * Parse a Hi-Flying UDP 48899 discovery reply ("<ip>,<mac>,<modelId>").
 */
export function parseHiflyingDiscoveryReply(message: string): HiflyingDiscoveredModule | null {
  const trimmed = message.trim();
  const parts = trimmed.split(',');
  if (parts.length < 2) {
    return null;
  }
  const ip = parts[0].trim();
  const mac = parts[1].trim().replace(/[:-]/g, '').toUpperCase();
  const modelId = (parts[2] ?? 'HF-LPB').trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) || !/^[0-9A-F]{12}$/.test(mac)) {
    return null;
  }
  return {
    ip,
    mac,
    modelId,
    raw: trimmed,
  };
}

/**
 * Parse `AT+WSCAN` output lines from a Hi-Flying Wi-Fi module.
 */
export function parseHiflyingSiteSurvey(response: string): HiflyingWifiSite[] {
  const lines = response
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('+ok') && !/^Ch\b/i.test(line));

  const sites: HiflyingWifiSite[] = [];
  for (const line of lines) {
    const cols = line.split(',');
    if (cols.length >= 5) {
      const signal = Number.parseInt(cols[4].trim(), 10);
      sites.push({
        channel: cols[0].trim(),
        ssid: cols[1].trim(),
        bssid: cols[2].trim(),
        security: cols[3].trim(),
        signalPercent: Number.isFinite(signal) ? signal : 0,
      });
    }
  }
  return sites;
}

/**
 * Discover Hi-Flying (`HF-LPB` / `AlorAir-R`) Wi-Fi modules on SoftAP (`10.10.100.254`) or LAN broadcast
 * using UDP port 48899 (`HF-A11ASSISTHREAD`).
 */
export async function discoverHiflyingModules(options: {
  targetAddress?: string;
  udpPort?: number;
  timeoutMs?: number;
} = {}): Promise<HiflyingDiscoveredModule[]> {
  const target = options.targetAddress ?? '255.255.255.255';
  const port = options.udpPort ?? HIFLYING_UDP_PORT;
  const timeoutMs = options.timeoutMs ?? 2500;

  return new Promise<HiflyingDiscoveredModule[]>((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const found = new Map<string, HiflyingDiscoveredModule>();

    const finish = () => {
      try {
        socket.close();
      } catch {
        // Ignore already-closed socket
      }
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on('error', (err) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Ignore
      }
      reject(err);
    });

    socket.on('message', (msg) => {
      const parsed = parseHiflyingDiscoveryReply(msg.toString('utf8'));
      if (parsed) {
        found.set(parsed.mac, parsed);
      }
    });

    socket.bind(0, () => {
      if (target === '255.255.255.255') {
        socket.setBroadcast(true);
      }
      const probe = Buffer.from(HIFLYING_ASSIST_KEY, 'ascii');
      socket.send(probe, port, target, (err) => {
        if (err) {
          clearTimeout(timer);
          try {
            socket.close();
          } catch {
            // Ignore
          }
          reject(err);
        }
      });
    });
  });
}

async function sendUdpCommand(
  socket: dgram.Socket,
  host: string,
  port: number,
  payload: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener('message', onMessage);
      reject(new Error(`UDP command timed out waiting for reply from ${host}:${port}`));
    }, timeoutMs);

    function onMessage(msg: Buffer): void {
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      resolve(msg.toString('utf8').trim());
    }

    socket.on('message', onMessage);
    socket.send(Buffer.from(payload, 'utf8'), port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        socket.removeListener('message', onMessage);
        reject(err);
      }
    });
  });
}

/**
 * Provision a Hi-Flying SoftAP module (`10.10.100.254` on UDP 48899) onto local 2.4 GHz Wi-Fi
 * and optionally point its outbound TCP socket directly at the Homebridge Local TCP server.
 */
export async function provisionHiflyingWifi(options: WifiProvisionOptions): Promise<WifiProvisionResult> {
  const targetIp = options.targetIp ?? HIFLYING_DEFAULT_AP_IP;
  const udpPort = options.udpPort ?? HIFLYING_UDP_PORT;
  const timeoutMs = options.timeoutMs ?? 4000;
  const securityMode = options.securityMode ?? (options.password ? 'WPA2PSK' : 'OPEN');
  const cipher = options.cipher ?? (options.password ? 'AES' : 'NONE');
  const steps: Array<{ command: string; response: string }> = [];

  if (!options.ssid || /[\r\n]/.test(options.ssid)) {
    return {
      success: false,
      steps,
      error: 'A valid 2.4 GHz Wi-Fi SSID without control characters is required.',
    };
  }
  if (/[\r\n]/.test(options.password)) {
    return {
      success: false,
      steps,
      error: 'Wi-Fi password contains unsupported newline characters.',
    };
  }

  const socket = dgram.createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });

    // 1. Unlock AT command session with HF-A11ASSISTHREAD
    const assistReply = await sendUdpCommand(socket, targetIp, udpPort, HIFLYING_ASSIST_KEY, timeoutMs);
    steps.push({ command: HIFLYING_ASSIST_KEY, response: assistReply });
    const moduleInfo = parseHiflyingDiscoveryReply(assistReply) ?? undefined;

    // 2. Confirm AT session with +ok
    const okReply = await sendUdpCommand(socket, targetIp, udpPort, '+ok', timeoutMs);
    steps.push({ command: '+ok', response: okReply });

    // 3. Switch module to Station (STA) mode
    const wmodeReply = await sendUdpCommand(socket, targetIp, udpPort, 'AT+WMODE=STA\r', timeoutMs);
    steps.push({ command: 'AT+WMODE=STA', response: wmodeReply });

    // 4. Set target 2.4 GHz SSID
    const ssidCmd = `AT+WSSSID=${options.ssid}\r`;
    const ssidReply = await sendUdpCommand(socket, targetIp, udpPort, ssidCmd, timeoutMs);
    steps.push({ command: `AT+WSSSID=${options.ssid}`, response: ssidReply });

    // 5. Set security & passphrase (redacted in returned steps log)
    const wskeyCmd = securityMode === 'OPEN'
      ? 'AT+WSKEY=OPEN,NONE\r'
      : `AT+WSKEY=${securityMode},${cipher},${options.password}\r`;
    const wskeyReply = await sendUdpCommand(socket, targetIp, udpPort, wskeyCmd, timeoutMs);
    steps.push({
      command: securityMode === 'OPEN' ? 'AT+WSKEY=OPEN,NONE' : `AT+WSKEY=${securityMode},${cipher},********`,
      response: wskeyReply,
    });

    // 6. Optional: Point outbound TCP connection directly to Homebridge local listener!
    if (options.redirectTcpServer) {
      const { host, port } = options.redirectTcpServer;
      const netpCmd = `AT+NETP=TCP,CLIENT,${port},${host}\r`;
      const netpReply = await sendUdpCommand(socket, targetIp, udpPort, netpCmd, timeoutMs);
      steps.push({ command: `AT+NETP=TCP,CLIENT,${port},${host}`, response: netpReply });
    }

    // 7. Reboot module to join the local Wi-Fi network
    if (options.rebootAfterSave !== false) {
      const rebootReply = await sendUdpCommand(socket, targetIp, udpPort, 'AT+Z\r', timeoutMs).catch(() => '+ok (rebooting)');
      steps.push({ command: 'AT+Z', response: rebootReply });
    }

    return {
      success: true,
      moduleInfo,
      steps,
    };
  } catch (err) {
    return {
      success: false,
      steps,
      error: (err as Error).message,
    };
  } finally {
    try {
      socket.close();
    } catch {
      // Ignore
    }
  }
}

/**
 * Scan nearby 2.4 GHz Wi-Fi networks visible to a Hi-Flying module in SoftAP mode.
 */
export async function scanHiflyingWifiSites(
  targetIp = HIFLYING_DEFAULT_AP_IP,
  udpPort = HIFLYING_UDP_PORT,
  timeoutMs = 5000,
): Promise<HiflyingWifiSite[]> {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });

    await sendUdpCommand(socket, targetIp, udpPort, HIFLYING_ASSIST_KEY, timeoutMs);
    await sendUdpCommand(socket, targetIp, udpPort, '+ok', timeoutMs);
    const scanOutput = await sendUdpCommand(socket, targetIp, udpPort, 'AT+WSCAN\r', timeoutMs);
    return parseHiflyingSiteSurvey(scanOutput);
  } finally {
    try {
      socket.close();
    } catch {
      // Ignore
    }
  }
}

