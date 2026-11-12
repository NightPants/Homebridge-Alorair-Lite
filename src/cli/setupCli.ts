#!/usr/bin/env node

import { randomBytes } from 'node:crypto';

import { AlorairCloudClient } from '../cloudApi.js';
import { AlorairLocalServer } from '../localServer.js';
import { formatMacColon } from '../models.js';
import {
  DEFAULT_LOCAL_PORT,
  DEFAULT_SETUP_PORTAL_HOST,
  DEFAULT_SETUP_PORTAL_PORT,
  HIFLYING_DEFAULT_AP_IP,
} from '../settings.js';
import { AlorairSetupPortal } from '../setupServer.js';
import type { AlorairDeviceState } from '../types.js';
import {
  discoverHiflyingModules,
  provisionHiflyingWifi,
  scanHiflyingWifiSites,
} from '../wifiProvisioner.js';

function getArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0 && index + 1 < args.length) {
    return args[index + 1];
  }
  return undefined;
}

function printHelp(): void {
  console.log(`
AlorAir Lite — Wi-Fi Recovery & Homebridge Setup CLI
=====================================================

Usage:
  npx homebridge-alorair-lite-setup [command] [options]

Commands:
  portal (default)      Start the local Web UI Setup Wizard + optional Local TCP sniffer
  discover-softap       Broadcast HF-A11ASSISTHREAD on UDP 48899 to find SoftAP/LAN modules
  scan-softap           Scan visible 2.4 GHz Wi-Fi networks from a Hi-Flying SoftAP module
  provision-softap      Provision 2.4 GHz Wi-Fi credentials onto a Hi-Flying (10.10.100.254) module
  discover-cloud        Authenticate to AlorAir-Lite Cloud and print all owned dehumidifiers
  listen-local          Listen on TCP port 6100 (or --port 6200) and print live dehumidifier frames

Options:
  --host <ip>           Bind address for portal or TCP listener (default: 127.0.0.1 for portal, 0.0.0.0 for TCP)
  --port <number>       Port number (default: 8589 for portal, 6100 for listen-local)
  --token <secret>      Access token for Setup Portal API (auto-generated when --host is non-loopback)
  --listen-tcp <port>   Also start a live Local TCP listener alongside the Web Portal (e.g. 6100)
  --target <ip>         Target IP for Hi-Flying commands (default: 10.10.100.254)
  --ssid <name>         2.4 GHz Wi-Fi SSID to provision
  --password <pass>     Wi-Fi or Cloud password
  --email <email>       AlorAir-Lite Cloud account email
  --redirect-host <ip>  Point Hi-Flying module TCP client directly at Homebridge IP
  --redirect-port <n>   TCP port for --redirect-host (default: 6100)
  --help                Show this help message
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'portal';
  const positionalArg = args[1] && !args[1].startsWith('--') ? args[1] : undefined;

  if (command === 'discover-hiflying' || command === 'discover-softap') {
    const target = getArgValue(args, '--target') ?? getArgValue(args, '--ip') ?? positionalArg ?? '255.255.255.255';
    console.log(`Scanning for Hi-Flying Wi-Fi modules via UDP 48899 (${target})...`);
    const modules = await discoverHiflyingModules({ targetAddress: target });
    if (modules.length === 0) {
      console.log('No Hi-Flying modules responded. Ensure you are connected to the unit hotspot (10.10.100.254) or same LAN.');
      return;
    }
    for (const mod of modules) {
      console.log(`Found module: IP=${mod.ip}  MAC=${formatMacColon(mod.mac)} (${mod.mac})  Model=${mod.modelId}`);
    }
    return;
  }

  if (command === 'scan-hiflying' || command === 'scan-softap') {
    const target = getArgValue(args, '--target') ?? getArgValue(args, '--ip') ?? positionalArg ?? HIFLYING_DEFAULT_AP_IP;
    console.log(`Scanning visible 2.4 GHz Wi-Fi networks from module ${target}...`);
    const sites = await scanHiflyingWifiSites(target);
    if (sites.length === 0) {
      console.log('No 2.4 GHz networks returned by AT+WSCAN.');
      return;
    }
    for (const site of sites) {
      console.log(`  Ch ${site.channel.padStart(2, ' ')} | ${site.signalPercent}% | ${site.security} | ${site.ssid}`);
    }
    return;
  }

  if (command === 'provision-hiflying' || command === 'provision-softap') {
    const ssid = getArgValue(args, '--ssid');
    const password = getArgValue(args, '--password') ?? '';
    const targetIp = getArgValue(args, '--target') ?? getArgValue(args, '--ip') ?? HIFLYING_DEFAULT_AP_IP;
    const redirectHost = getArgValue(args, '--redirect-host');
    const redirectPort = Number.parseInt(getArgValue(args, '--redirect-port') ?? String(DEFAULT_LOCAL_PORT), 10);

    if (!ssid) {
      console.error('Error: --ssid <2.4GHz_SSID> is required for provision-softap.');
      process.exitCode = 1;
      return;
    }

    console.log(`Provisioning Hi-Flying module at ${targetIp} onto 2.4 GHz SSID "${ssid}"...`);
    const result = await provisionHiflyingWifi({
      targetIp,
      ssid,
      password,
      redirectTcpServer: redirectHost ? { host: redirectHost, port: redirectPort } : undefined,
    });

    for (const step of result.steps) {
      console.log(`  ${step.command} -> ${step.response}`);
    }
    if (!result.success) {
      console.error(`Provisioning failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log('Success! Module is rebooting onto your 2.4 GHz Wi-Fi network.');
    return;
  }

  if (command === 'discover-cloud') {
    const email = getArgValue(args, '--email');
    const password = getArgValue(args, '--password');
    if (!email || !password) {
      console.error('Error: --email and --password are required for discover-cloud.');
      process.exitCode = 1;
      return;
    }

    console.log('Authenticating with AlorAir-Lite Cloud...');
    const client = new AlorairCloudClient({
      username: email,
      password,
      allowInsecureHttp: true,
    });
    const devices = await client.discoverOwnedDevices();
    if (devices.length === 0) {
      console.log('Authenticated successfully, but no owned devices were found on this account.');
      return;
    }
    console.log(`Found ${devices.length} owned device(s):`);
    for (const dev of devices) {
      console.log(JSON.stringify({
        mac: dev.mac,
        macColon: formatMacColon(dev.mac),
        name: dev.fields.name ?? dev.fields.productName,
        model: dev.fields.productName ?? dev.fields.model,
        powerStatus: dev.fields.powerStatus,
        inHumidity: dev.fields.inHumidity,
        targetHumidity: dev.fields.currentHumidity,
        updateTimeStr: dev.fields.updateTimeStr,
      }, null, 2));
    }
    return;
  }

  if (command === 'listen-local') {
    const host = getArgValue(args, '--host') ?? '0.0.0.0';
    const port = Number.parseInt(getArgValue(args, '--port') ?? positionalArg ?? String(DEFAULT_LOCAL_PORT), 10);
    const server = new AlorairLocalServer({
      listenHost: host,
      listenPort: port,
      controllerProfile: 'auto',
      onConnect: (info) => {
        console.log(`[CONNECTED] Dehumidifier MAC=${formatMacColon(info.macHex)} (${info.macHex}) from IP=${info.remoteAddress}`);
      },
      onStatus: (report) => {
        console.log(
          `[STATUS] profile=${report.profile} mac=${report.macHex} power=${String(report.power)} `
          + `inRH=${String(report.inletHumidity)}% inTemp=${String(report.inletCelsius)}C target=${String(report.targetHumidity)} `
          + `draining=${String(report.draining)}`,
        );
      },
      onDisconnect: (info) => {
        console.log(`[DISCONNECTED] session=${info.sessionId} reason=${info.reason}`);
      },
      onFrameLog: (msg) => {
        console.log(`[FRAME] ${msg}`);
      },
    });
    const addr = await server.start();
    console.log(`Listening for inbound AlorAir TCP connections on ${addr.host}:${addr.port} (Ctrl+C to stop)...`);
    console.log(
      'Tip: Point DNS hostname "online-app.toovem.com" '
      + '(and "nlb-f2xfnhpq30h62dr13l.us-west-1.nlb.aliyuncsslbintl.com" on consumer routers) '
      + 'to this machine IP and power-cycle your dehumidifier.',
    );
    process.on('SIGINT', () => {
      void server.close().then(() => process.exit(0));
    });
    return;
  }

  // Default: start interactive Web Portal (and optional TCP sniffer)
  const portalHost = getArgValue(args, '--host') ?? DEFAULT_SETUP_PORTAL_HOST;
  const portalPort = Number.parseInt(getArgValue(args, '--port') ?? String(DEFAULT_SETUP_PORTAL_PORT), 10);
  const normalizedHost = portalHost.trim().toLowerCase();
  const isLoopback = normalizedHost === '127.0.0.1' || normalizedHost === 'localhost' || normalizedHost === '::1';
  const explicitToken = getArgValue(args, '--token')?.trim();
  const portalToken = explicitToken || (!isLoopback ? randomBytes(16).toString('hex') : undefined);
  const tcpPortStr = getArgValue(args, '--listen-tcp');
  const liveStates = new Map<string, AlorairDeviceState>();

  let localServer: AlorairLocalServer | null = null;
  if (tcpPortStr) {
    const tcpPort = Number.parseInt(tcpPortStr, 10);
    localServer = new AlorairLocalServer({
      listenHost: '0.0.0.0',
      listenPort: tcpPort,
      controllerProfile: 'auto',
      onStatus: (report) => {
        liveStates.set(report.macHex, {
          mac: report.macHex,
          deviceNum: report.macHex,
          name: `AlorAir ${formatMacColon(report.macHex).slice(-8)}`,
          model: report.profile === 'sentinel' ? 'AlorAir Sentinel' : 'AlorAir-Lite LGR',
          firmwareVersion: '1.0.0',
          transport: 'local',
          online: true,
          stale: false,
          power: report.power,
          targetReachedIdle: false,
          mode: report.targetHumidity === 20 ? 'continuous' : 'auto',
          targetHumidity: report.targetHumidity === 20 ? null : report.targetHumidity,
          lastAutoHumidity: report.targetHumidity && report.targetHumidity >= 25 ? report.targetHumidity : 50,
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
          defrosting: null,
          locating: report.locating,
          compressorActive: report.compressorActive,
          fanActive: report.fanActive,
          temperatureUnit: report.temperatureUnit,
          moistureUnit: null,
          workingHours: report.workingHours,
          rawErrorMask: null,
          faultCodes: [],
          filters: [],
          sampleTimestampIso: report.receivedAtIso,
          observedAtIso: report.receivedAtIso,
          pendingPower: null,
          restartDelayRemainingSeconds: 0,
          lastCommand: null,
        });
      },
      onConnect: (info) => {
        console.log(`[TCP] Dehumidifier connected: MAC=${formatMacColon(info.macHex)} from ${info.remoteAddress}`);
      },
    });
    const tcpAddr = await localServer.start();
    console.log(`Live Local TCP listener started on ${tcpAddr.host}:${tcpAddr.port}`);
  }

  const portal = new AlorairSetupPortal({
    host: portalHost,
    port: portalPort,
    authToken: portalToken,
    getDevicesSnapshot: () => [...liveStates.values()],
    onLog: (msg) => console.log(`[SetupPortal] ${msg}`),
  });
  const url = await portal.start();
  const displayUrl = portalToken ? `${url}/?token=${portalToken}` : url;
  console.log(`\nAlorAir Lite Wi-Fi & Setup Wizard running at: ${displayUrl}`);
  if (portalToken && !explicitToken) {
    console.log('Generated a one-time access token because --host listens beyond 127.0.0.1.');
  }
  console.log('Open that URL in Chrome or Edge to provision Wi-Fi (BLE or SoftAP) and generate your Homebridge config.');
  console.log('Press Ctrl+C to stop.\n');

  process.on('SIGINT', () => {
    void Promise.all([
      portal.close(),
      localServer ? localServer.close() : Promise.resolve(),
    ]).then(() => process.exit(0));
  });
}

void main().catch((err) => {
  console.error('Fatal setup CLI error:', (err as Error).message);
  process.exit(1);
});

