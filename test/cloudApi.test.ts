import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  AlorairCloudClient,
  AuthenticationError,
  CommandError,
  ProtocolError,
  encryptVendorPassword,
} from '../src/cloudApi.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 1024,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AlorairCloudClient', () => {
  it('requires explicit allowInsecureHttp consent for http:// base URLs', () => {
    assert.throws(
      () => new AlorairCloudClient({
        username: 'owner@example.com',
        password: 'secret',
        allowInsecureHttp: false,
        baseUrl: 'http://online-app1.toovem.com:8081/rest/api/',
        publicKeyPem: publicKey,
      }),
      ProtocolError,
    );
  });

  it('encrypts login password with RSA-PKCS1v15, verifies device ownership, and sends exact control frames', async () => {
    const sentRequests: Array<{ method: string; url: string; headers: Headers; body: Record<string, unknown> | null }> = [];
    const nowUtcStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' && init.body.length > 0
        ? JSON.parse(init.body) as Record<string, unknown>
        : null;
      sentRequests.push({ method, url, headers, body });

      assert.equal(headers.get('env'), 'app');
      assert.equal(headers.get('platform'), '1');
      assert.equal(headers.get('App-Identity'), '1');

      if (url.endsWith('/user/login')) {
        assert.ok(body);
        assert.equal(body.username, 'owner@example.com');
        assert.equal(body.method, 1);
        const decrypted = privateDecrypt(
          { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
          Buffer.from(String(body.password), 'base64'),
        ).toString('utf8');
        assert.equal(decrypted, 'MyS3cretPass!');
        return jsonResponse({ code: 200, data: { token: 'tok_abc123' } });
      }

      assert.equal(headers.get('token'), 'tok_abc123');

      if (url.endsWith('/user/getUserInfo')) {
        return jsonResponse({ code: 200, data: { uid: 'user_42' } });
      }

      if (url.includes('/iot/device/getHistoryDeviceList')) {
        return jsonResponse({
          code: 200,
          data: {
            totalPage: 1,
            list: [
              {
                id: 'dev_owned',
                userId: 'user_42',
                deviceNum: '000000000000aabbcc112233',
              },
              {
                id: 'dev_guest',
                userId: 'other_user_99',
                deviceNum: '000000000000ffeeddccbbaa',
              },
            ],
          },
        });
      }

      if (url.endsWith('/iot/device/getDeviceDetail/dev_owned')) {
        return jsonResponse({
          code: 200,
          data: {
            id: 'dev_owned',
            userId: 'user_42',
            deviceNum: '000000000000aabbcc112233',
            name: 'Crawlspace Storm Pro',
            productName: 'Storm Pro',
            firmwareVersion: '2.0.8',
            powerStatus: '01',
            drainStatus: '00',
            errCode: '20',
            currentHumidity: 45,
            inHumidity: 58,
            outHumidity: 36,
            inCelsius: 21,
            outCelsius: 25,
            temperatureUnit: 1,
            humidityUnit: 0,
            updateTimeStr: nowUtcStr,
            filter: [
              { id: 'flt_1', recommendUseHour: 1000, useHour: 250, extendUseHour: 0 },
            ],
          },
        });
      }

      if (url.endsWith('/iot/device/control') || url.includes('/iot/device/resetFilter/')) {
        return jsonResponse({ code: 200, data: {} });
      }

      return jsonResponse({ code: 404 }, 404);
    };

    const client = new AlorairCloudClient({
      username: 'owner@example.com',
      password: 'MyS3cretPass!',
      allowInsecureHttp: true,
      baseUrl: 'http://online-app1.toovem.com:8081/rest/api',
      publicKeyPem: publicKey,
      fetchImpl: mockFetch,
    });

    const owned = await client.discoverOwnedDevices();
    assert.equal(owned.length, 1);
    assert.equal(owned[0].mac, 'AABBCC112233');
    assert.equal(owned[0].deviceNum, '000000000000AABBCC112233');
    assert.equal(owned[0].filters.length, 1);
    assert.equal(owned[0].filters[0].remainingPercent, 75);

    await client.setPower('AA:BB:CC:11:22:33', true);
    await client.setHumidity('AABBCC112233', 20);
    await client.setTemperatureUnit('AABBCC112233', 'fahrenheit');
    await client.resetFilter('AABBCC112233');

    const controlCalls = sentRequests.filter((r) => r.url.endsWith('/iot/device/control'));
    assert.equal(controlCalls.length, 3);

    // Power uses string frameType "21" and includes deviceNum
    assert.deepEqual(controlCalls[0].body, {
      deviceId: 'dev_owned',
      deviceNum: '000000000000AABBCC112233',
      frameType: '21',
      data: '01',
    });

    // Continuous humidity uses string frameType "23" and data "20"
    assert.deepEqual(controlCalls[1].body, {
      deviceId: 'dev_owned',
      deviceNum: '000000000000AABBCC112233',
      frameType: '23',
      data: '20',
    });

    // Display unit uses JSON number frameType 24 and omits deviceNum
    assert.deepEqual(controlCalls[2].body, {
      deviceId: 'dev_owned',
      frameType: 24,
      data: '01',
    });
  });

  it('refuses HTTP redirects and never retries uncertain command failures', async () => {
    let controlAttempts = 0;
    const nowUtcStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const redirectFetch: typeof fetch = async () => new Response(null, {
      status: 302,
      headers: { Location: 'http://evil.example.com/login' },
    });

    const redirectClient = new AlorairCloudClient({
      username: 'owner@example.com',
      password: 'secret',
      allowInsecureHttp: true,
      publicKeyPem: publicKey,
      fetchImpl: redirectFetch,
    });
    await assert.rejects(() => redirectClient.login(), ProtocolError);

    const dropOnCommandFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/user/login')) {
        return jsonResponse({ code: 200, data: { token: 'tok_1' } });
      }
      if (url.endsWith('/user/getUserInfo')) {
        return jsonResponse({ code: 200, data: { uid: 'u1' } });
      }
      if (url.includes('/getHistoryDeviceList')) {
        return jsonResponse({
          code: 200,
          data: {
            totalPage: 1,
            list: [{ id: 'd1', userId: 'u1', deviceNum: 'AABBCCDDEEFF' }],
          },
        });
      }
      if (url.endsWith('/getDeviceDetail/d1')) {
        return jsonResponse({
          code: 200,
          data: {
            id: 'd1',
            userId: 'u1',
            deviceNum: 'AABBCCDDEEFF',
            powerStatus: '01',
            updateTimeStr: nowUtcStr,
          },
        });
      }
      if (url.endsWith('/iot/device/control')) {
        controlAttempts += 1;
        throw new Error('socket hang up');
      }
      return jsonResponse({ code: 404 }, 404);
    };

    const cmdClient = new AlorairCloudClient({
      username: 'owner@example.com',
      password: 'secret',
      allowInsecureHttp: true,
      publicKeyPem: publicKey,
      fetchImpl: dropOnCommandFetch,
    });

    await assert.rejects(
      async () => {
        await cmdClient.setPower('AABBCCDDEEFF', false);
      },
      (err: unknown) => err instanceof CommandError && err.outcomeUnknown === true,
    );
    assert.equal(controlAttempts, 1);

    assert.throws(() => encryptVendorPassword('', publicKey));
  });

  it('stops retrying login after the vendor rejects credentials to prevent account lockout', async () => {
    let loginAttempts = 0;

    const badPassFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/user/login')) {
        loginAttempts += 1;
        return jsonResponse({ code: 10002, msg: 'Invalid username or password' });
      }
      return jsonResponse({ code: 404 }, 404);
    };

    const badPassClient = new AlorairCloudClient({
      username: 'owner@example.com',
      password: 'WrongPassword!',
      allowInsecureHttp: true,
      publicKeyPem: publicKey,
      fetchImpl: badPassFetch,
    });

    await assert.rejects(() => badPassClient.discoverOwnedDevices(), AuthenticationError);
    assert.equal(badPassClient.isAuthRejected, true);
    assert.equal(loginAttempts, 1);

    // Subsequent calls must fail fast without hitting /user/login again
    await assert.rejects(() => badPassClient.discoverOwnedDevices(), AuthenticationError);
    await assert.rejects(() => badPassClient.login(), AuthenticationError);
    assert.equal(loginAttempts, 1);
  });
});

