import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { describe, it } from 'node:test';

import { AlorairSetupPortal } from '../src/setupServer.js';
import {
  buildBleWifiCredentialBuffer,
  chunkBlePayload,
  describeBleStatusCode,
  discoverHiflyingModules,
  parseBleNotificationPayload,
  parseHiflyingSiteSurvey,
  provisionHiflyingWifi,
  scanHiflyingWifiSites,
} from '../src/wifiProvisioner.js';

describe('Wi-Fi Provisioner (BK7231 BLE & Hi-Flying SoftAP UDP) and Setup Portal', () => {
  it('encodes BK7231 BLE payloads (vendor SSID;P: default + legacy fallbacks), chunks, and maps 0xFFF1 status codes', () => {
    const vendor = buildBleWifiCredentialBuffer('Basement24G', 'DehumPass123');
    assert.equal(vendor.toString('latin1'), 'Basement24G;P:DehumPass123');

    const jsonPasswd = buildBleWifiCredentialBuffer('Basement24G', 'DehumPass123', 'json_passwd');
    assert.equal(jsonPasswd.toString('utf8'), '{"ssid":"Basement24G","passwd":"DehumPass123"}');

    const jsonPassword = buildBleWifiCredentialBuffer('Basement24G', 'DehumPass123', 'json_password');
    assert.equal(jsonPassword.toString('utf8'), '{"ssid":"Basement24G","password":"DehumPass123"}');

    const jsonPwd = buildBleWifiCredentialBuffer('Basement24G', 'DehumPass123', 'json_pwd');
    assert.equal(jsonPwd.toString('utf8'), '{"ssid":"Basement24G","pwd":"DehumPass123"}');

    const chunks = chunkBlePayload(jsonPasswd, 20);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].length, 20);
    assert.equal(chunks[1].length, 20);
    assert.equal(Buffer.concat(chunks).toString('utf8'), jsonPasswd.toString('utf8'));

    const notif = parseBleNotificationPayload(Buffer.from('WIFI_OK MAC=AA:BB:CC:DD:EE:FF', 'utf8'));
    assert.equal(notif.extractedMac, 'AABBCCDDEEFF');

    const binaryIdle = parseBleNotificationPayload(
      Buffer.from('000000000000fc584aa2165303', 'hex'),
    );
    assert.equal(binaryIdle.extractedMac, 'FC584AA21653');
    assert.equal(binaryIdle.statusCode, 0x03);
    assert.equal(binaryIdle.statusDescription, '0x03 Wi-Fi Join Failed / Not Connected');

    const binaryRejected = parseBleNotificationPayload(
      Buffer.from('000000000000fc584aa2165302', 'hex'),
    );
    assert.equal(binaryRejected.extractedMac, 'FC584AA21653');
    assert.equal(binaryRejected.statusCode, 0x02);
    assert.equal(binaryRejected.statusDescription, '0x02 Credentials Received / Connecting to Wi-Fi');

    const binaryAccepted = parseBleNotificationPayload(
      Buffer.from('000000000000fc584aa2165301', 'hex'),
    );
    assert.equal(binaryAccepted.statusCode, 0x01);
    assert.equal(binaryAccepted.statusDescription, '0x01 Joined Wi-Fi (Success)');

    assert.equal(describeBleStatusCode(0x99), '0x99 Unknown Status');
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

  it('serves the Setup Portal UI, requires Content-Type: application/json and token on non-loopback hosts', async () => {
    assert.throws(
      () => new AlorairSetupPortal({ host: '0.0.0.0', port: 0 }),
      /setupPortalToken is required/i,
    );

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
      assert.ok(html.includes('writeBlePayloadChunked'));
      assert.ok(html.includes('writeBlePayloadSingle'));
      assert.ok(html.includes(';P:'));
      assert.ok(html.includes('0x03 Wi-Fi Join Failed / Not Connected'));

      const wrongTypeGetRes = await fetch(`${baseUrl}/api/status`, {
        headers: { 'x-setup-token': 'setup_tok_99' },
      });
      assert.equal(wrongTypeGetRes.status, 415);

      const wrongTypePostRes = await fetch(`${baseUrl}/api/hiflying/provision`, {
        method: 'POST',
        headers: {
          'x-setup-token': 'setup_tok_99',
          'Content-Type': 'text/plain',
        },
        body: JSON.stringify({ ssid: 'Test', password: 'Pass' }),
      });
      assert.equal(wrongTypePostRes.status, 415);

      const crossSiteRes = await fetch(`${baseUrl}/api/status`, {
        headers: {
          'x-setup-token': 'setup_tok_99',
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'cross-site',
        },
      });
      assert.equal(crossSiteRes.status, 403);

      const unauthRes = await fetch(`${baseUrl}/api/status`, {
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(unauthRes.status, 401);

      const authRes = await fetch(`${baseUrl}/api/status`, {
        headers: {
          'x-setup-token': 'setup_tok_99',
          'Content-Type': 'application/json',
        },
      });
      assert.equal(authRes.status, 200);
      const statusJson = await authRes.json() as { defaultLocalPort: number };
      assert.equal(statusJson.defaultLocalPort, 6100);
    } finally {
      await portal.close();
    }
  });
});

