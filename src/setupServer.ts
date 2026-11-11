import http from 'node:http';
import os from 'node:os';

import { AlorairCloudClient } from './cloudApi.js';
import { formatMacColon } from './models.js';
import {
  DEFAULT_LOCAL_PORT,
  DEFAULT_SETUP_PORTAL_HOST,
  DEFAULT_SETUP_PORTAL_PORT,
  HIFLYING_DEFAULT_AP_IP,
} from './settings.js';
import type { AlorairDeviceState } from './types.js';
import {
  discoverHiflyingModules,
  provisionHiflyingWifi,
  scanHiflyingWifiSites,
} from './wifiProvisioner.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface SetupPortalOptions {
  host?: string;
  port?: number;
  authToken?: string;
  getDevicesSnapshot?: () => AlorairDeviceState[];
  onLog?: (message: string) => void;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function hasJsonContentType(req: http.IncomingMessage): boolean {
  const raw = req.headers['content-type'];
  if (typeof raw !== 'string') {
    return false;
  }
  const mediaType = raw.split(';')[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

function getLocalIpv4Addresses(): Array<{ name: string; address: string }> {
  const nets = os.networkInterfaces();
  const list: Array<{ name: string; address: string }> = [];
  for (const [name, entries] of Object.entries(nets)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        list.push({ name, address: entry.address });
      }
    }
  }
  return list;
}

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('Expected JSON object body'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export class AlorairSetupPortal {
  private readonly host: string;
  private readonly port: number;
  private readonly authToken: string | null;
  private server: http.Server | null = null;
  private boundPort: number | null = null;

  constructor(private readonly options: SetupPortalOptions = {}) {
    this.host = options.host?.trim() || DEFAULT_SETUP_PORTAL_HOST;
    this.port = options.port ?? DEFAULT_SETUP_PORTAL_PORT;
    this.authToken = options.authToken?.trim() ? options.authToken.trim() : null;
    if (!isLoopbackHost(this.host) && !this.authToken) {
      throw new Error('setupPortalToken is required whenever setupPortalHost listens beyond 127.0.0.1');
    }
  }

  public get url(): string | null {
    if (this.boundPort === null) {
      return null;
    }
    const displayHost = this.host === '0.0.0.0' ? '127.0.0.1' : this.host;
    return `http://${displayHost}:${this.boundPort}`;
  }

  public async start(): Promise<string> {
    if (this.server) {
      return this.url!;
    }
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      function onError(err: Error): void {
        server.removeListener('listening', onListening);
        reject(err);
      }
      function onListening(): void {
        server.removeListener('error', onError);
        resolve();
      }
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });

    this.server = server;
    const addr = server.address();
    this.boundPort = addr && typeof addr === 'object' ? addr.port : this.port;
    return this.url!;
  }

  public async close(): Promise<void> {
    if (!this.server) {
      return;
    }
    const srv = this.server;
    this.server = null;
    this.boundPort = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  private isAuthorized(req: http.IncomingMessage, parsedUrl: URL): boolean {
    if (!this.authToken) {
      return true;
    }
    const headerToken = req.headers['x-setup-token'];
    if (typeof headerToken === 'string' && headerToken === this.authToken) {
      return true;
    }
    if (parsedUrl.searchParams.get('token') === this.authToken) {
      return true;
    }
    return false;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && parsedUrl.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(buildSetupPortalHtml());
      return;
    }

    if (req.headers['sec-fetch-site'] === 'cross-site') {
      sendJson(res, 403, { error: 'Forbidden: cross-site requests are not allowed.' });
      return;
    }

    if (!hasJsonContentType(req)) {
      sendJson(res, 415, { error: 'Unsupported Media Type: Content-Type: application/json is required.' });
      return;
    }

    if (!this.isAuthorized(req, parsedUrl)) {
      sendJson(res, 401, { error: 'Unauthorized: supply a valid setupPortalToken.' });
      return;
    }

    try {
      if (req.method === 'GET' && parsedUrl.pathname === '/api/status') {
        const devices = this.options.getDevicesSnapshot?.() ?? [];
        sendJson(res, 200, {
          hostInterfaces: getLocalIpv4Addresses(),
          defaultLocalPort: DEFAULT_LOCAL_PORT,
          devices,
        });
        return;
      }

      if (req.method === 'GET' && parsedUrl.pathname === '/api/hiflying/discover') {
        const target = parsedUrl.searchParams.get('target') || '255.255.255.255';
        const modules = await discoverHiflyingModules({ targetAddress: target, timeoutMs: 2500 });
        sendJson(res, 200, { modules });
        return;
      }

      if (req.method === 'GET' && parsedUrl.pathname === '/api/hiflying/scan') {
        const target = parsedUrl.searchParams.get('target') || HIFLYING_DEFAULT_AP_IP;
        const sites = await scanHiflyingWifiSites(target);
        sendJson(res, 200, { sites });
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/hiflying/provision') {
        const body = await readJsonBody(req);
        const ssid = typeof body.ssid === 'string' ? body.ssid.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const targetIp = typeof body.targetIp === 'string' && body.targetIp.trim()
          ? body.targetIp.trim()
          : HIFLYING_DEFAULT_AP_IP;
        const redirectHost = typeof body.redirectHost === 'string' && body.redirectHost.trim()
          ? body.redirectHost.trim()
          : '';
        const redirectPort = typeof body.redirectPort === 'number'
          ? body.redirectPort
          : DEFAULT_LOCAL_PORT;

        this.options.onLog?.(`Provisioning Hi-Flying Wi-Fi module at ${targetIp} for SSID "${ssid}"`);
        const result = await provisionHiflyingWifi({
          targetIp,
          ssid,
          password,
          redirectTcpServer: redirectHost ? { host: redirectHost, port: redirectPort } : undefined,
        });
        sendJson(res, result.success ? 200 : 400, result);
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/cloud/discover') {
        const body = await readJsonBody(req);
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const client = new AlorairCloudClient({
          username: email,
          password,
          allowInsecureHttp: true,
        });
        const owned = await client.discoverOwnedDevices();
        sendJson(res, 200, {
          devices: owned.map((d) => ({
            mac: d.mac,
            macFormatted: formatMacColon(d.mac),
            deviceNum: d.deviceNum,
            name: d.fields.name ?? d.fields.productName ?? 'AlorAir Dehumidifier',
            model: d.fields.productName ?? d.fields.model ?? 'AlorAir-Lite',
            firmwareVersion: d.fields.firmwareVersion ?? d.fields.version ?? 'unknown',
            powerStatus: d.fields.powerStatus ?? null,
            inHumidity: d.fields.inHumidity ?? null,
            currentHumidity: d.fields.currentHumidity ?? null,
            updateTimeStr: d.fields.updateTimeStr ?? null,
            filters: d.filters,
          })),
        });
        return;
      }

      sendJson(res, 404, { error: 'Endpoint not found' });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  }
}

function buildSetupPortalHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AlorAir Lite — Wi-Fi Recovery &amp; Homebridge Setup</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --ok: #22c55e;
      --warn: #f59e0b;
      --err: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 24px 16px 64px;
    }
    .container { max-width: 920px; margin: 0 auto; }
    header { margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    h1 { margin: 0 0 6px; font-size: 24px; color: var(--accent); }
    p.sub { margin: 0; color: var(--muted); font-size: 14px; }
    .tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
    .tab-btn {
      background: var(--card);
      color: var(--muted);
      border: 1px solid var(--border);
      padding: 10px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
    }
    .tab-btn.active { background: var(--accent); color: #082f49; border-color: var(--accent); }
    .panel { display: none; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
    .panel.active { display: block; }
    h2 { margin-top: 0; font-size: 18px; }
    label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; color: #cbd5e1; }
    input, select {
      width: 100%;
      padding: 9px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #0f172a;
      color: var(--text);
      font-size: 14px;
    }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 640px) { .row { grid-template-columns: 1fr; } }
    button.action {
      margin-top: 14px;
      background: var(--accent);
      color: #082f49;
      border: none;
      padding: 10px 18px;
      border-radius: 6px;
      font-weight: 700;
      cursor: pointer;
      font-size: 14px;
      margin-right: 8px;
    }
    button.action:hover { background: var(--accent-hover); color: #fff; }
    button.secondary { background: #334155; color: var(--text); }
    pre.log {
      background: #020617;
      border: 1px solid var(--border);
      padding: 12px;
      border-radius: 8px;
      font-size: 12px;
      overflow-x: auto;
      max-height: 260px;
      color: #cbd5e1;
      margin-top: 14px;
      white-space: pre-wrap;
    }
    .callout {
      background: rgba(56, 189, 248, 0.1);
      border-left: 4px solid var(--accent);
      padding: 10px 14px;
      border-radius: 4px;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
    }
    .badge.ok { background: rgba(34,197,94,0.2); color: var(--ok); }
    .badge.warn { background: rgba(245,158,11,0.2); color: var(--warn); }
  </style>
</head>
<body>
<div class="container">
  <header>
    <h1>AlorAir Lite — Wi-Fi Provisioning &amp; Homebridge Setup</h1>
    <p class="sub">Reconnect your ALORAIR Smart WiFi LGR Dehumidifier to 2.4 GHz Wi-Fi and Apple HomeKit — even if the vendor mobile app stopped working.</p>
  </header>

  <div class="tabs">
    <button class="tab-btn active" onclick="showTab('ble')">1. BLE Wi-Fi Setup (AlorAir-Lite / BK7231)</button>
    <button class="tab-btn" onclick="showTab('softap')">2. SoftAP Wi-Fi Setup (Legacy LGR / HF-LPB)</button>
    <button class="tab-btn" onclick="showTab('cloud')">3. Cloud Account Scanner</button>
    <button class="tab-btn" onclick="showTab('local')">4. Local TCP Status &amp; Config Generator</button>
  </div>

  <!-- TAB 1: BLE -->
  <div id="tab-ble" class="panel active">
    <h2>Bluetooth (BLE) Wi-Fi Provisioning — Newer LGR Controllers (2023+)</h2>
    <div class="callout">
      <strong>Step 1 — Put your LGR Dehumidifier into Pairing Mode:</strong><br/>
      1. Power on the dehumidifier. If your LCD menu has a <em>Wi-Fi Hotspot</em> toggle, ensure it is <strong>OFF</strong>.<br/>
      2. Hold <strong>PURGE + MENU</strong> (or <strong>UP + DOWN</strong> on compact panels) for
      <strong>3–5 seconds</strong> until the unit beeps and the Wi-Fi icon flashes.<br/>
      3. Open this page in <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> on a computer/Android device
      with Bluetooth enabled (do <em>not</em> pair in OS Bluetooth settings).
    </div>
    <div class="row">
      <div>
        <label>2.4 GHz Wi-Fi Network Name (SSID)</label>
        <input id="ble-ssid" placeholder="MyHome24GHz" />
      </div>
      <div>
        <label>2.4 GHz Wi-Fi Password</label>
        <input id="ble-pass" type="password" placeholder="Wi-Fi Password" />
      </div>
    </div>
    <label>BLE Credential Frame Format (Service 0xFFF0 / Write 0xFFF2)</label>
    <select id="ble-format">
      <option value="ssid_p">Vendor Format — SSID;P:password (single write, Recommended)</option>
      <option value="auto">Auto — Try All Formats</option>
      <option value="json_passwd">Legacy JSON — {"ssid":"...","passwd":"..."}</option>
      <option value="json_password">Legacy JSON — {"ssid":"...","password":"..."}</option>
      <option value="json_pwd">Legacy JSON — {"ssid":"...","pwd":"..."}</option>
      <option value="at_wifi">AT Command — AT+WJAP=ssid,password</option>
    </select>
    <div>
      <button class="action" onclick="connectBle()">Scan &amp; Connect via Web Bluetooth</button>
      <button class="action secondary" onclick="sendBleWifi()">Send Wi-Fi Credentials (0xFFF2)</button>
    </div>
    <pre id="ble-log" class="log">Ready. Click "Scan &amp; Connect via Web Bluetooth" to look for bk7231 / BK-alorair (Service 0xFFF0)...</pre>
  </div>

  <!-- TAB 2: SOFTAP -->
  <div id="tab-softap" class="panel">
    <h2>Hi-Flying SoftAP Wi-Fi Setup — Pre-2023 LGR Controllers (10.10.100.254)</h2>
    <div class="callout">
      <strong>When to use this tab:</strong> Earlier Smart WiFi LGR units (originally paired with the retired
      <em>AlorAir-R</em> app) broadcast a temporary Wi-Fi hotspot named <code>HF-LPB</code>,
      <code>hiflying_softap</code>, or <code>ALORAIR_xxxx</code> when Wi-Fi Hotspot is turned ON in the
      <strong>MENU</strong>. Connect this computer's Wi-Fi to that open hotspot (gateway <code>10.10.100.254</code>),
      then provision below.
    </div>
    <div class="row">
      <div>
        <label>Module IP Address (UDP Port 48899)</label>
        <input id="hf-ip" value="10.10.100.254" />
      </div>
      <div>
        <label>Optional Direct Homebridge TCP Redirect IP (Skip Cloud)</label>
        <input id="hf-redirect" placeholder="Leave blank for vendor cloud, or enter Homebridge LAN IP" />
      </div>
    </div>
    <div class="row">
      <div>
        <label>2.4 GHz Wi-Fi SSID</label>
        <input id="hf-ssid" placeholder="MyHome24GHz" />
      </div>
      <div>
        <label>2.4 GHz Wi-Fi Password</label>
        <input id="hf-pass" type="password" placeholder="Wi-Fi Password" />
      </div>
    </div>
    <div>
      <button class="action secondary" onclick="discoverHf()">1. Discover Module (UDP 48899)</button>
      <button class="action secondary" onclick="scanHf()">2. Scan Visible 2.4 GHz Networks</button>
      <button class="action" onclick="provisionHf()">3. Push Wi-Fi &amp; Reboot Module</button>
    </div>
    <pre id="hf-log" class="log">Ready to discover or provision Hi-Flying Wi-Fi module...</pre>
  </div>

  <!-- TAB 3: CLOUD -->
  <div id="tab-cloud" class="panel">
    <h2>AlorAir-Lite Cloud Account Scanner</h2>
    <div class="callout">
      If your dehumidifier is already on Wi-Fi and linked to an AlorAir-Lite account, test your login here to retrieve
      its exact 12-digit Wi-Fi MAC address and current sensor readings.
    </div>
    <div class="row">
      <div>
        <label>AlorAir-Lite Account Email</label>
        <input id="cld-email" placeholder="you@example.com" />
      </div>
      <div>
        <label>AlorAir-Lite Account Password</label>
        <input id="cld-pass" type="password" placeholder="Account Password" />
      </div>
    </div>
    <button class="action" onclick="scanCloud()">Login &amp; List Owned Dehumidifiers</button>
    <pre id="cld-log" class="log">Enter your AlorAir-Lite credentials above to test cloud discovery...</pre>
  </div>

  <!-- TAB 4: LOCAL STATUS & CONFIG -->
  <div id="tab-local" class="panel">
    <h2>Zero-Cloud Local TCP Status &amp; Homebridge Config Generator</h2>
    <div class="callout">
      <strong>How Zero-Cloud Local TCP Works:</strong> Even if AlorAir's app and cloud servers go offline permanently,
      your dehumidifier resolves <code>online-app.toovem.com</code> via DHCP DNS at boot and opens a plaintext TCP
      connection to port <strong>6100</strong> (AlorAir-Lite / Storm LGR) or <strong>6200</strong> (Sentinel). Point
      <code>online-app.toovem.com</code> to your Homebridge IP in Pi-hole, AdGuard Home, UniFi, or your router's Local
      DNS, then power-cycle the dehumidifier!
    </div>
    <button class="action secondary" onclick="refreshStatus()">Refresh Connected Devices &amp; Host IPs</button>
    <pre id="local-log" class="log">Loading status...</pre>
  </div>
</div>

<script>
  let bleDevice = null;
  let bleWriteChar = null;
  let lastNotifyStatus = null;
  let lastNotifyTimeMs = 0;
  const qsToken = new URLSearchParams(location.search).get('token') || '';

  function apiHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (qsToken) h['x-setup-token'] = qsToken;
    return h;
  }

  function showTab(id) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + id).classList.add('active');
    const idx = ['ble', 'softap', 'cloud', 'local'].indexOf(id);
    if (idx >= 0) document.querySelectorAll('.tab-btn')[idx].classList.add('active');
    if (id === 'local') refreshStatus();
  }

  function appendLog(elId, msg) {
    const el = document.getElementById(elId);
    const ts = new Date().toLocaleTimeString();
    el.textContent += '\\n[' + ts + '] ' + msg;
    el.scrollTop = el.scrollHeight;
  }

  async function connectBle() {
    if (!navigator.bluetooth) {
      appendLog('ble-log', 'ERROR: Web Bluetooth is not supported in this browser. Open this URL in Chrome or Edge over localhost or HTTPS.');
      return;
    }
    try {
      appendLog('ble-log', 'Requesting BLE device (looking for bk7231 / BK-alorair / Service 0xFFF0)...');
      bleDevice = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'bk' },
          { namePrefix: 'BK' },
          { namePrefix: 'alorair' },
          { services: [0xfff0] }
        ],
        optionalServices: [0xfff0]
      });
      appendLog('ble-log', 'Selected BLE device: ' + (bleDevice.name || bleDevice.id));
      const server = await bleDevice.gatt.connect();
      appendLog('ble-log', 'Connected to GATT server. Discovering service 0xFFF0...');
      const service = await server.getPrimaryService(0xfff0);
      try {
        const notifyChar = await service.getCharacteristic(0xfff1);
        await notifyChar.startNotifications();
        notifyChar.addEventListener('characteristicvaluechanged', (ev) => {
          const dv = ev.target.value;
          const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
          const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
          const txt = new TextDecoder().decode(bytes);
          let extra = '';
          if (bytes.length >= 13 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0 && bytes[4] === 0 && bytes[5] === 0) {
            const macColon = Array.from(bytes.slice(6, 12)).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
            const code = bytes[12];
            lastNotifyStatus = code;
            lastNotifyTimeMs = Date.now();
            const hexCode = '0x' + code.toString(16).padStart(2, '0');
            const statusLabel = code === 1
              ? ' (0x01 Joined Wi-Fi — SUCCESS!)'
              : code === 0
                ? ' (0x00 Accepted)'
                : code === 2
                  ? ' (0x02 Credentials Received — Connecting to Wi-Fi...)'
                  : code === 3
                    ? ' (0x03 Wi-Fi Join Failed / Not Connected)'
                    : ' (' + hexCode + ' Unknown Status)';
            extra = ' -> Device Wi-Fi MAC=' + macColon + ', status=' + hexCode + statusLabel;
          }
          appendLog('ble-log', 'RX Notify (0xFFF1): HEX=[' + hex + '] UTF8=' + JSON.stringify(txt) + extra);
        });
        appendLog('ble-log', 'Subscribed to notifications on 0xFFF1.');
      } catch (e) {
        appendLog('ble-log', 'Note: 0xFFF1 notification setup skipped (' + e.message + ').');
      }
      bleWriteChar = await service.getCharacteristic(0xfff2);
      const props = bleWriteChar.properties
        ? ('write=' + Boolean(bleWriteChar.properties.write) + ', writeWithoutResponse=' + Boolean(bleWriteChar.properties.writeWithoutResponse))
        : 'unknown';
      appendLog('ble-log', 'Ready! Characteristic 0xFFF2 acquired (' + props + '). Enter your 2.4 GHz SSID & password and click "Send Wi-Fi Credentials".');
    } catch (e) {
      appendLog('ble-log', 'BLE Error: ' + e.message);
    }
  }

  async function writeBlePayloadSingle(bytes, label) {
    const useWithResponse = bleWriteChar.properties && bleWriteChar.properties.write;
    appendLog('ble-log', 'Writing ' + bytes.length + ' bytes in ONE GATT write (' + label + ')...');
    lastNotifyStatus = null;
    if (useWithResponse && bleWriteChar.writeValueWithResponse) {
      await bleWriteChar.writeValueWithResponse(bytes);
    } else if (!useWithResponse && bleWriteChar.writeValueWithoutResponse) {
      await bleWriteChar.writeValueWithoutResponse(bytes);
    } else {
      await bleWriteChar.writeValue(bytes);
    }
  }

  async function writeBlePayloadChunked(bytes, label) {
    const useWithResponse = bleWriteChar.properties && bleWriteChar.properties.write;
    const chunkSize = 20;
    const totalChunks = Math.ceil(bytes.length / chunkSize);
    appendLog('ble-log', 'Writing ' + bytes.length + ' bytes in ' + totalChunks + 'x 20-byte BLE chunks with 60ms pacing (' + label + ')...');
    lastNotifyStatus = null;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const slice = bytes.slice(offset, offset + chunkSize);
      if (useWithResponse && bleWriteChar.writeValueWithResponse) {
        await bleWriteChar.writeValueWithResponse(slice);
      } else if (!useWithResponse && bleWriteChar.writeValueWithoutResponse) {
        await bleWriteChar.writeValueWithoutResponse(slice);
      } else {
        await bleWriteChar.writeValue(slice);
      }
      if (offset + chunkSize < bytes.length) {
        await new Promise(r => setTimeout(r, 60));
      }
    }
  }

  async function sendBleWifi() {
    if (!bleWriteChar) {
      appendLog('ble-log', 'Connect via Web Bluetooth first.');
      return;
    }
    const ssid = document.getElementById('ble-ssid').value.trim();
    const pass = document.getElementById('ble-pass').value;
    const fmt = document.getElementById('ble-format').value;
    if (!ssid) {
      appendLog('ble-log', 'Enter a 2.4 GHz Wi-Fi SSID first.');
      return;
    }

    const enc = new TextEncoder();
    const latin1 = (s) => Uint8Array.from(Array.from(s), (ch) => ch.charCodeAt(0) & 0xff);
    const candidates = [
      { key: 'ssid_p', label: 'SSID;P:password', single: true, bytes: latin1(ssid + ';P:' + pass) },
      { key: 'json_passwd', label: '{"ssid":"...","passwd":"..."}', bytes: enc.encode(JSON.stringify({ ssid: ssid, passwd: pass })) },
      { key: 'json_password', label: '{"ssid":"...","password":"..."}', bytes: enc.encode(JSON.stringify({ ssid: ssid, password: pass })) },
      { key: 'json_pwd', label: '{"ssid":"...","pwd":"..."}', bytes: enc.encode(JSON.stringify({ ssid: ssid, pwd: pass })) },
      { key: 'at_wifi', label: 'AT+WJAP=ssid,password', bytes: enc.encode('AT+WJAP=' + ssid + ',' + pass + '\\r\\n') },
    ];

    const listToTry = fmt === 'auto' ? candidates : candidates.filter(c => c.key === fmt);

    try {
      for (const item of listToTry) {
        const beforeMs = Date.now();
        if (item.single) {
          await writeBlePayloadSingle(item.bytes, item.label);
        } else {
          await writeBlePayloadChunked(item.bytes, item.label);
        }
        // The unit replies 0x02 immediately on write, then takes ~15-60s to join Wi-Fi and report 0x01 (or 0x03 on failure).
        appendLog('ble-log', 'Waiting up to 60s for 0x01 (joined Wi-Fi) or 0x03 (failed)...');
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 250));
          if (lastNotifyTimeMs >= beforeMs && (lastNotifyStatus === 1 || lastNotifyStatus === 3)) {
            break;
          }
        }
        if (lastNotifyTimeMs >= beforeMs && lastNotifyStatus === 1) {
          appendLog('ble-log', 'SUCCESS! Dehumidifier joined 2.4 GHz Wi-Fi using format ' + item.key + '.');
          return;
        }
        if (lastNotifyTimeMs >= beforeMs && lastNotifyStatus === 3) {
          appendLog('ble-log', 'Unit reported 0x03 (Wi-Fi join failed). Check the SSID/password (case-sensitive) and that the network is 2.4 GHz WPA2.');
          if (item.key === 'ssid_p') {
            return;
          }
        }
      }
      appendLog('ble-log', 'Finished. No 0x01 received — check SSID/password, then re-enter pairing mode and try again.');
    } catch (e) {
      appendLog('ble-log', 'Write failed: ' + e.message);
    }
  }

  async function discoverHf() {
    const ip = document.getElementById('hf-ip').value.trim() || '255.255.255.255';
    appendLog('hf-log', 'Sending HF-A11ASSISTHREAD to ' + ip + ':48899...');
    const res = await fetch('/api/hiflying/discover?target=' + encodeURIComponent(ip), { headers: apiHeaders() });
    const data = await res.json();
    appendLog('hf-log', JSON.stringify(data, null, 2));
  }

  async function scanHf() {
    const ip = document.getElementById('hf-ip').value.trim() || '10.10.100.254';
    appendLog('hf-log', 'Running AT+WSCAN on ' + ip + '...');
    const res = await fetch('/api/hiflying/scan?target=' + encodeURIComponent(ip), { headers: apiHeaders() });
    const data = await res.json();
    appendLog('hf-log', JSON.stringify(data, null, 2));
  }

  async function provisionHf() {
    const targetIp = document.getElementById('hf-ip').value.trim() || '10.10.100.254';
    const ssid = document.getElementById('hf-ssid').value.trim();
    const password = document.getElementById('hf-pass').value;
    const redirectHost = document.getElementById('hf-redirect').value.trim();
    appendLog('hf-log', 'Provisioning Wi-Fi SSID "' + ssid + '" on ' + targetIp + '...');
    const res = await fetch('/api/hiflying/provision', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ targetIp, ssid, password, redirectHost, redirectPort: 6100 })
    });
    const data = await res.json();
    appendLog('hf-log', JSON.stringify(data, null, 2));
  }

  async function scanCloud() {
    const email = document.getElementById('cld-email').value.trim();
    const password = document.getElementById('cld-pass').value;
    const el = document.getElementById('cld-log');
    el.textContent = 'Authenticating with AlorAir-Lite cloud...';
    const res = await fetch('/api/cloud/discover', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    el.textContent = JSON.stringify(data, null, 2);
  }

  async function refreshStatus() {
    const el = document.getElementById('local-log');
    const res = await fetch('/api/status', { headers: apiHeaders() });
    const data = await res.json();
    const primaryIp = (data.hostInterfaces && data.hostInterfaces[0] && data.hostInterfaces[0].address) || '<YOUR_HOMEBRIDGE_IP>';
    const firstMac = (data.devices && data.devices[0] && data.devices[0].mac) || '';
    const sampleConfig = {
      platform: 'AlorairLite',
      name: 'AlorAir Lite',
      transport: 'local',
      listenHost: primaryIp,
      listenPort: 6100,
      mac: firstMac,
      controllerProfile: 'auto',
      allowLocalPowerOn: true,
      exposeContinuousSwitch: true,
      exposeProblemSensor: true
    };
    el.textContent = '=== Host LAN IPv4 Interfaces ===\\n'
      + JSON.stringify(data.hostInterfaces, null, 2)
      + '\\n\\n=== Active Dehumidifier Sessions ===\\n'
      + JSON.stringify(data.devices, null, 2)
      + '\\n\\n=== Recommended Zero-Cloud Local TCP Homebridge Config ===\\n'
      + '1. Add Local DNS Record on Router / Pi-hole / AdGuard: online-app.toovem.com -> ' + primaryIp + '\\n'
      + '2. Power-cycle dehumidifier so it connects to ' + primaryIp + ':6100\\n'
      + '3. Paste into Homebridge config.json platforms[]:\\n'
      + JSON.stringify(sampleConfig, null, 2);
  }
</script>
</body>
</html>`;
}

