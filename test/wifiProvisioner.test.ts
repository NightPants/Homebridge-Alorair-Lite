import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { describe, it } from 'node:test';

import { AlorairSetupPortal } from '../src/setupServer.js';
import {
  buildBleWifiCredentialBuffer,
  chunkBlePayload,
  discoverHiflyingModules,
  parseBleNotificationPayload,
  parseHiflyingSiteSurvey,
  provisionHiflyingWifi,
  scanHiflyingWifiSites,
} from '../src/wifiProvisioner.js';

describe('Wi-Fi Provisioner (BK7231 BLE & Hi-Flying SoftAP UDP) and Setup Portal', () => {
  it('encodes BK7231 BLE payloads, chunks to 20-byte ATT MTU slices, and extracts MACs from notifications', () => {
    const jsonPasswd = buildBleWifiCredentialBuffer('Basement24G', 'DehumPass123', 'json_passwd');
    assert.equal(jsonPasswd.toString('utf8'), '{"ssid":"Basement24G","passwd":"DehumPass123"}');

    const chunks = chunkBlePayload(jsonPasswd, 20);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].length, 20);
    assert.equal(chunks[1].length, 20);
    assert.equal(Buffer.concat(chunks).toString('utf8'), jsonPasswd.toString('utf8'));

    const notif = parseBleNotificationPayload(Buffer.from('WIFI_OK MAC=AA:BB:CC:DD:EE:FF', 'utf8'));
    assert.equal(notif.extractedMac, 'AABBCCDDEEFF');
  });

  it('discovers, scans, and provisions a simulated Hi-Flying HF-LPB UDP module with password redaction', async () => {
    const receivedCommands: string[] = [];
    const mockModule = dgram.createSocket('udp4');

    await new Promise<void>((resolve) => {
      mockModule.bind(0, '127.0.0.1', () => resolve());
    });
    const modulePort = (mockModule.address() as { port: number }).port;

    mockModule.on('message', (msg, rinfo) => {
      const cmd = msg.toString('utf8');
      receivedCommands.push(cmd);

      let reply = '+ok\r\n\r\n';
      if (cmd === 'HF-A11ASSISTHREAD') {
        reply = '10.10.100.254,ACCF23AABBCC,HF-LPB100';
      } else if (cmd === 'AT+WSCAN\r') {
        reply = [
          '+ok=',
          'Ch,SSID,BSSID,Security,Indicator',
          '6,HomeIoT_24G,11:22:33:44:55:66,WPA2PSK/AES,88',
          '11,GuestNet,AA:BB:CC:DD:EE:11,OPEN/NONE,54',
        ].join('\r\n');
      }
      mockModule.send(Buffer.from(reply, 'utf8'), rinfo.port, rinfo.address);
    });

    try {
      const discovered = await discoverHiflyingModules({
        targetAddress: '127.0.0.1',
        udpPort: modulePort,
        timeoutMs: 150,
      });
      assert.equal(discovered.length, 1);
      assert.equal(discovered[0].mac, 'ACCF23AABBCC');
      assert.equal(discovered[0].modelId, 'HF-LPB100');

      const sites = await scanHiflyingWifiSites('127.0.0.1', modulePort, 1000);
      assert.equal(sites.length, 2);
      assert.equal(sites[0].ssid, 'HomeIoT_24G');
      assert.equal(sites[0].signalPercent, 88);

      const prov = await provisionHiflyingWifi({
        targetIp: '127.0.0.1',
        udpPort: modulePort,
        ssid: 'HomeIoT_24G',
        password: 'SuperSecretWifiPassword',
        redirectTcpServer: { host: '192.168.1.50', port: 6100 },
        timeoutMs: 1000,
      });

      assert.equal(prov.success, true);
      assert.equal(prov.moduleInfo?.mac, 'ACCF23AABBCC');
      // Verify actual wire command included password and TCP redirect
      assert.ok(receivedCommands.includes('AT+WSKEY=WPA2PSK,AES,SuperSecretWifiPassword\r'));
      assert.ok(receivedCommands.includes('AT+NETP=TCP,CLIENT,6100,192.168.1.50\r'));
      assert.ok(receivedCommands.includes('AT+Z\r'));
      // Verify returned log steps redact the Wi-Fi password
      const serializedSteps = JSON.stringify(prov.steps);
      assert.equal(serializedSteps.includes('SuperSecretWifiPassword'), false);
      assert.equal(serializedSteps.includes('********'), true);
    } finally {
      mockModule.close();
    }

    assert.equal(parseHiflyingSiteSurvey('+ok=\r\n').length, 0);
  });

  it('serves the Setup Portal UI and enforces setupPortalToken on API routes', async () => {
    const portal = new AlorairSetupPortal({
      host: '127.0.0.1',
      port: 0,
      authToken: 'setup_tok_99',
      getDevicesSnapshot: () => [],
    });

    const baseUrl = await portal.start();
    try {
      const htmlRes = await fetch(`${baseUrl}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.ok(html.includes('Web Bluetooth'));

      const unauthRes = await fetch(`${baseUrl}/api/status`);
      assert.equal(unauthRes.status, 401);

      const authRes = await fetch(`${baseUrl}/api/status`, {
        headers: { 'x-setup-token': 'setup_tok_99' },
      });
      assert.equal(authRes.status, 200);
      const statusJson = await authRes.json() as { defaultLocalPort: number };
      assert.equal(statusJson.defaultLocalPort, 6100);
    } finally {
      await portal.close();
    }
  });
});

