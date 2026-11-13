import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';

import {
  NativeFrameStream,
  decodeNativeFrame,
  encodeNativeFrame,
} from '../src/localProtocol.js';
import { AlorairLocalServer } from '../src/localServer.js';

const TEST_MAC_HEX = 'AABBCC112233';
const TEST_MAC_BYTES = Buffer.from(TEST_MAC_HEX, 'hex');

function buildStormLiteStatusFrame(opts: {
  opcode: number;
  power: boolean;
  draining?: boolean;
  inletCelsius?: number;
  inletHumidity?: number;
  outletCelsius?: number;
  outletHumidity?: number;
  targetHumidity?: number;
  fahrenheitDisplay?: boolean;
  timestamp?: number;
}): Buffer {
  const data = Buffer.alloc(34, 0);
  data[3] = opts.power ? 1 : 0;
  data[4] = opts.draining ? 1 : 0;

  const inC = opts.inletCelsius ?? 20;
  const inF = Math.floor((inC * 9) / 5 + 32);
  data.writeInt8(inC, 8);
  data.writeInt8(inF, 9);
  data[10] = opts.inletHumidity ?? 58;

  const outC = opts.outletCelsius ?? 26;
  const outF = Math.floor((outC * 9) / 5 + 32);
  data.writeInt8(outC, 11);
  data.writeInt8(outF, 12);
  data[13] = opts.outletHumidity ?? 34;

  data.writeUInt16BE(68, 14);
  data.writeUInt16BE(10, 16);
  data.writeUInt16BE(42, 18);
  data.writeUInt16BE(6, 20);

  data[23] = opts.targetHumidity ?? 50;
  data[32] = opts.fahrenheitDisplay ? 1 : 0;

  return encodeNativeFrame({
    macBytes: TEST_MAC_BYTES,
    timestamp: opts.timestamp ?? 1_730_000_000,
    fn: 0x07,
    opcode: opts.opcode,
    data,
  });
}

function buildSentinelStatusFrame(opts: {
  opcode: number;
  power: number;
  continuous: boolean;
  targetHumidity: number;
  inletHumidity: number;
}): Buffer {
  const data = Buffer.alloc(45, 0);
  data[3] = opts.power;
  data[6] = 1; // compressor
  data[7] = 1; // fan
  data.writeInt8(22, 8);
  data.writeInt8(Math.floor((22 * 9) / 5 + 32), 9);
  data[10] = opts.inletHumidity;
  data[23] = opts.targetHumidity;
  data.writeUInt16BE(120, 28);
  data[44] = opts.continuous ? 0x02 : 0x01;

  return encodeNativeFrame({
    macBytes: TEST_MAC_BYTES,
    timestamp: 1_730_000_010,
    fn: 0x0b,
    opcode: opts.opcode,
    data,
  });
}

describe('AlorairLocalServer & NativeFrameStream', () => {
  it('reassembles fragmented TCP chunks, auto-replies to keepalives, and resolves outbound commands', async () => {
    const reports: Array<{ power: boolean | null; targetHumidity: number | null }> = [];
    const server = new AlorairLocalServer({
      listenHost: '127.0.0.1',
      listenPort: 0,
      controllerProfile: 'auto',
      commandTimeoutMs: 4000,
      onStatus: (r) => {
        reports.push({ power: r.power, targetHumidity: r.targetHumidity });
      },
    });

    const bound = await server.start();
    const client = net.createConnection({ host: '127.0.0.1', port: bound.port });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });

    const inboundToAppliance = new NativeFrameStream(TEST_MAC_BYTES);
    const rxFrames: Array<ReturnType<typeof decodeNativeFrame>> = [];
    let onApplianceRx: ((frame: ReturnType<typeof decodeNativeFrame>) => void) | null = null;

    client.on('data', (chunk: Buffer) => {
      for (const { frame } of inboundToAppliance.feed(chunk)) {
        rxFrames.push(frame);
        onApplianceRx?.(frame);
      }
    });

    try {
      // 1. Send keepalive frame fragmented across two writes -> expect fn=0x09, op=0x01, data=0x00 reply
      const keepalive = encodeNativeFrame({
        macBytes: TEST_MAC_BYTES,
        timestamp: 1_730_000_001,
        fn: 0x09,
        opcode: 0x01,
        data: Buffer.alloc(0),
      });

      const keepaliveReplyPromise = new Promise<ReturnType<typeof decodeNativeFrame>>((resolve) => {
        onApplianceRx = resolve;
      });
      client.write(keepalive.subarray(0, 11));
      await new Promise((r) => setTimeout(r, 20));
      client.write(keepalive.subarray(11));

      const reply = await keepaliveReplyPromise;
      assert.equal(reply.fn, 0x09);
      assert.equal(reply.opcode, 0x01);
      assert.deepEqual(reply.data, Buffer.from([0x00]));

      // 2. Send initial Storm/Lite status (power=true, target=50%)
      const initialStatus = buildStormLiteStatusFrame({
        opcode: 0x02,
        power: true,
        inletCelsius: -5,
        inletHumidity: 62,
        targetHumidity: 50,
      });
      client.write(initialStatus);
      await new Promise((r) => setTimeout(r, 40));

      assert.equal(server.connected, true);
      assert.equal(server.learnedMac, TEST_MAC_HEX);
      assert.equal(server.lastStatus?.inletCelsius, -5);
      assert.equal(server.lastStatus?.inletHumidity, 62);
      assert.equal(server.lastStatus?.targetHumidity, 50);

      // 3. Issue setHumidity(20) [Continuous] -> real appliance sends standard status frame op=0x1c
      onApplianceRx = (cmdFrame) => {
        if (cmdFrame.fn === 0x09 && cmdFrame.opcode === 0x23) {
          assert.equal(cmdFrame.data[0], 20);
          const ackStatus = buildStormLiteStatusFrame({
            opcode: 0x1c,
            power: true,
            inletHumidity: 61,
            targetHumidity: 20,
          });
          client.write(ackStatus);
        }
      };

      const updated = await server.setHumidity(20);
      assert.equal(updated.continuous, true);
      assert.equal(updated.targetHumidity, 20);

      // 4. Verify 45-byte Sentinel frame is also decoded in 'auto' controllerProfile
      client.write(buildSentinelStatusFrame({
        opcode: 0x02,
        power: 1,
        continuous: false,
        targetHumidity: 45,
        inletHumidity: 54,
      }));
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(server.lastStatus?.profile, 'sentinel');
      assert.equal(server.lastStatus?.targetHumidity, 45);
      assert.equal(server.lastStatus?.workingHours, 120);
    } finally {
      client.destroy();
      await server.close();
    }
  });

  it('decodes real BK7231 wire frames with <class> <checksum8> 0x16 trailers', () => {
    // Real captured BK7231 keepalive frame for MAC FC:58:4A:AF:AE:25 (16-bit prefix sum = 0x0345, class = 0x02, cksum8 = 0x45)
    const rawKeepalive = Buffer.from(
      '0d0e000000000000fc584aafae25000000000000090100000000024516',
      'hex',
    );
    const decodedKa = decodeNativeFrame(rawKeepalive);
    assert.equal(decodedKa.macHex, 'FC584AAFAE25');
    assert.equal(decodedKa.fn, 0x09);
    assert.equal(decodedKa.opcode, 0x01);
    assert.equal(decodedKa.classByte, 0x02);

    // Real captured cloud setpoint=45 command frame (16-bit prefix sum = 0x0674, class = 0x05, cksum8 = 0x74)
    const rawCmd = Buffer.from(
      '0d0e000000000000a02442abcdef6a64f3d100010923000000002d057416',
      'hex',
    );
    const decodedCmd = decodeNativeFrame(rawCmd);
    assert.equal(decodedCmd.macHex, 'A02442ABCDEF');
    assert.equal(decodedCmd.fn, 0x09);
    assert.equal(decodedCmd.opcode, 0x23);
    assert.equal(decodedCmd.data[0], 45);
    assert.equal(decodedCmd.classByte, 0x05);
  });
});

