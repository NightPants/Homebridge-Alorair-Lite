import net from 'node:net';

import {
  buildHumidityCommand,
  buildKeepaliveReply,
  buildLocateCommand,
  buildPowerCommand,
  buildPurgeCommand,
  buildTemperatureUnitCommand,
  type DecodedNativeStatus,
  encodeNativeFrame,
  NativeFrameStream,
  decodeObservedStatus,
} from './localProtocol.js';
import { normalizeMac } from './models.js';
import type { LocalControllerProfile, TemperatureDisplayUnit } from './types.js';

export const COMMAND_SPACING_MS = 1100;

export class LocalServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalServerError';
  }
}

export class NotConnectedError extends LocalServerError {
  constructor(message = 'No current verified appliance connection') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

export class StaleLocalStatusError extends LocalServerError {
  constructor(message = 'Fresh local status is required on the current connection') {
    super(message);
    this.name = 'StaleLocalStatusError';
  }
}

export class CommandUncertainError extends LocalServerError {
  public readonly reason: string;

  constructor(reason: string) {
    super('Command delivery is uncertain; no automatic retry was sent');
    this.name = 'CommandUncertainError';
    this.reason = reason;
  }
}

export interface LocalStatusReport extends DecodedNativeStatus {
  sessionId: number;
  receiveSequence: number;
  receivedAtMs: number;
  receivedAtIso: string;
  remoteAddress: string;
}

export interface AlorairLocalServerConfig {
  listenHost: string;
  listenPort: number;
  allowedClientIp?: string;
  mac?: string;
  controllerProfile?: LocalControllerProfile;
  commandTimeoutMs?: number;
  statusMaxAgeMs?: number;
  readTimeoutMs?: number;
  onStatus?: (status: LocalStatusReport) => void;
  onConnect?: (info: { sessionId: number; remoteAddress: string; macHex: string }) => void;
  onDisconnect?: (info: { sessionId: number; reason: string }) => void;
  onFrameLog?: (message: string) => void;
}

interface PendingLocalCommand {
  opcode: number;
  expectedValue: unknown;
  queued: boolean;
  receiveSequence: number;
  byteBoundary: number;
  resolve: (status: LocalStatusReport) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface ActiveSession {
  sessionId: number;
  socket: net.Socket;
  remoteAddress: string;
  macBytes: Buffer | null;
  macHex: string | null;
  profile: 'lite' | 'sentinel';
  verified: boolean;
  receiveSequence: number;
  totalBytesReceived: number;
  pending: PendingLocalCommand | null;
  disconnectReason: string;
}

function normalizeRemoteIpv4(addr: string | undefined): string {
  if (!addr) {
    return '';
  }
  if (addr.startsWith('::ffff:')) {
    return addr.slice(7);
  }
  return addr;
}

export class AlorairLocalServer {
  private readonly listenHost: string;
  private readonly listenPort: number;
  private readonly allowedClientIp: string | null;
  private readonly configuredMacBytes: Buffer | null;
  private readonly configuredMacHex: string | null;
  private readonly controllerProfile: LocalControllerProfile;
  private readonly commandTimeoutMs: number;
  private readonly statusMaxAgeMs: number;
  private readonly readTimeoutMs: number;

  private server: net.Server | null = null;
  private boundAddress: { host: string; port: number } | null = null;
  private session: ActiveSession | null = null;
  private lastStatusReport: LocalStatusReport | null = null;
  private sessionCounter = 0;
  private closing = false;
  private lastOutboundTimeMs: number | null = null;
  private lastOutboundTimestampSec: number | null = null;
  private sendChain: Promise<void> = Promise.resolve();
  private commandChain: Promise<void> = Promise.resolve();

  constructor(private readonly config: AlorairLocalServerConfig) {
    this.listenHost = config.listenHost || '0.0.0.0';
    if (!Number.isInteger(config.listenPort) || config.listenPort < 0 || config.listenPort > 65535) {
      throw new LocalServerError('Listen port must be between 0 and 65535');
    }
    this.listenPort = config.listenPort;
    this.allowedClientIp = config.allowedClientIp?.trim() ? config.allowedClientIp.trim() : null;

    if (config.mac?.trim()) {
      const cleanMac = normalizeMac(config.mac);
      if (!cleanMac) {
        throw new LocalServerError('Configured MAC must be 12 hexadecimal digits');
      }
      this.configuredMacHex = cleanMac;
      this.configuredMacBytes = Buffer.from(cleanMac, 'hex');
    } else {
      this.configuredMacHex = null;
      this.configuredMacBytes = null;
    }

    this.controllerProfile = config.controllerProfile ?? 'lite';
    this.commandTimeoutMs = config.commandTimeoutMs ?? 10_000;
    this.statusMaxAgeMs = config.statusMaxAgeMs ?? 35_000;
    this.readTimeoutMs = config.readTimeoutMs ?? 90_000;
  }

  public get address(): { host: string; port: number } | null {
    return this.boundAddress;
  }

  public get connected(): boolean {
    return Boolean(!this.closing && this.session && this.session.verified && !this.session.socket.destroyed);
  }

  public get lastStatus(): LocalStatusReport | null {
    return this.connected ? this.lastStatusReport : null;
  }

  public get learnedMac(): string | null {
    return this.session?.macHex ?? this.lastStatusReport?.macHex ?? this.configuredMacHex;
  }

  public async start(): Promise<{ host: string; port: number }> {
    if (this.server || this.closing) {
      throw new LocalServerError('Local TCP server cannot be started twice');
    }

    const server = net.createServer((socket) => this.handleConnection(socket));
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
      server.listen(this.listenPort, this.listenHost);
    });

    this.server = server;
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      this.boundAddress = { host: addr.address, port: addr.port };
    } else {
      this.boundAddress = { host: this.listenHost, port: this.listenPort };
    }
    return this.boundAddress;
  }

  private handleConnection(socket: net.Socket): void {
    const remoteIp = normalizeRemoteIpv4(socket.remoteAddress);
    if (this.closing || (this.allowedClientIp && remoteIp !== this.allowedClientIp) || this.session !== null) {
      this.config.onFrameLog?.(
        `Rejected inbound TCP connection from ${remoteIp || 'unknown'}`
        + `${this.session ? ' (session already active)' : ''}`,
      );
      socket.destroy();
      return;
    }

    this.sessionCounter += 1;
    const session: ActiveSession = {
      sessionId: this.sessionCounter,
      socket,
      remoteAddress: remoteIp,
      macBytes: this.configuredMacBytes,
      macHex: this.configuredMacHex,
      profile: 'lite',
      verified: false,
      receiveSequence: 0,
      totalBytesReceived: 0,
      pending: null,
      disconnectReason: 'eof',
    };
    this.session = session;
    this.lastStatusReport = null;

    socket.setNoDelay(true);
    socket.setTimeout(this.readTimeoutMs);

    const stream = new NativeFrameStream(this.configuredMacBytes);

    socket.on('timeout', () => {
      session.disconnectReason = 'idle_timeout';
      socket.destroy();
    });

    socket.on('error', () => {
      session.disconnectReason = this.closing ? 'server_closed' : 'connection_error';
      socket.destroy();
    });

    socket.on('data', (chunk: Buffer) => {
      if (this.closing || this.session !== session) {
        return;
      }
      const firstFrameOffset = session.totalBytesReceived - stream.bufferedBytes;
      session.totalBytesReceived += chunk.length;
      session.receiveSequence += 1;
      const receivedAtMs = Date.now();
      const receivedAtIso = new Date(receivedAtMs).toISOString();

      let parsedFrames: Array<{ raw: Buffer; frame: ReturnType<NativeFrameStream['feed']>[number]['frame'] }>;
      try {
        parsedFrames = stream.feed(chunk);
      } catch (err) {
        session.disconnectReason = 'invalid_frame';
        this.config.onFrameLog?.(`Invalid native TCP frame from ${remoteIp}: ${(err as Error).message}`);
        socket.destroy();
        return;
      }

      let cursorOffset = firstFrameOffset;
      for (const { raw, frame } of parsedFrames) {
        const frameOffset = cursorOffset;
        cursorOffset += raw.length;

        if (!session.macBytes) {
          session.macBytes = frame.macBytes;
          session.macHex = frame.macHex;
        } else if (!session.macBytes.equals(frame.macBytes)) {
          session.disconnectReason = 'invalid_frame';
          socket.destroy();
          return;
        }

        const wasVerified = session.verified;
        session.verified = true;
        if (!wasVerified) {
          this.config.onConnect?.({
            sessionId: session.sessionId,
            remoteAddress: session.remoteAddress,
            macHex: frame.macHex,
          });
        }

        // Device keepalive: fn=0x09, op=0x01, empty data, zero reserved
        if (
          frame.fn === 0x09
          && frame.opcode === 0x01
          && frame.data.length === 0
          && frame.reserved.equals(Buffer.alloc(4, 0))
        ) {
          this.config.onFrameLog?.(`RX keepalive from ${frame.macHex} (${remoteIp})`);
          void this.enqueueSend(session, 0x01, Buffer.from([0x00]), false).catch(() => undefined);
          continue;
        }

        let decoded: DecodedNativeStatus | null;
        try {
          decoded = decodeObservedStatus(frame, this.controllerProfile);
        } catch (err) {
          session.disconnectReason = 'invalid_frame';
          this.config.onFrameLog?.(`Status decode error from ${frame.macHex}: ${(err as Error).message}`);
          socket.destroy();
          return;
        }

        if (decoded) {
          session.profile = decoded.profile;
          const report: LocalStatusReport = {
            ...decoded,
            sessionId: session.sessionId,
            receiveSequence: session.receiveSequence,
            receivedAtMs,
            receivedAtIso,
            remoteAddress: session.remoteAddress,
          };
          this.lastStatusReport = report;
          this.config.onFrameLog?.(
            `RX status (${decoded.profile}) mac=${frame.macHex} op=0x${frame.opcode.toString(16).padStart(2, '0')} `
            + `power=${String(decoded.power)} inRH=${String(decoded.inletHumidity)}% target=${String(decoded.targetHumidity)}`,
          );

          const pending = session.pending;
          if (
            pending
            && pending.queued
            && frame.opcode === pending.opcode
            && session.receiveSequence > pending.receiveSequence
            && frameOffset >= pending.byteBoundary
          ) {
            const actual = this.extractPendingField(report, pending.opcode);
            if (actual === pending.expectedValue) {
              session.pending = null;
              if (pending.timer) {
                clearTimeout(pending.timer);
              }
              pending.resolve(report);
            }
          }

          this.config.onStatus?.(report);
        } else {
          this.config.onFrameLog?.(
            `RX unmapped frame fn=0x${frame.fn.toString(16)} op=0x${frame.opcode.toString(16)} len=${frame.data.length}`,
          );
        }
      }
    });

    socket.on('end', () => {
      try {
        stream.assertCleanEOF();
      } catch {
        session.disconnectReason = 'invalid_frame';
      }
      socket.end();
    });

    socket.on('close', () => {
      if (this.closing) {
        session.disconnectReason = 'server_closed';
      }
      if (this.session === session) {
        this.session = null;
        this.lastStatusReport = null;
      }
      const pending = session.pending;
      if (pending) {
        session.pending = null;
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        pending.reject(
          pending.queued
            ? new CommandUncertainError('disconnected')
            : new NotConnectedError('Connection closed before command was queued'),
        );
      }
      this.config.onDisconnect?.({
        sessionId: session.sessionId,
        reason: session.disconnectReason,
      });
    });
  }

  private extractPendingField(report: LocalStatusReport, opcode: number): unknown {
    switch (opcode) {
      case 0x21:
        return report.power;
      case 0x23:
        return report.targetHumidity;
      case 0x24:
        return report.temperatureUnit;
      case 0x22:
        return report.draining;
      case 0x27:
        return report.locating;
      default:
        return undefined;
    }
  }

  private requireFreshSession(allowStale: boolean): ActiveSession {
    const session = this.session;
    if (!this.connected || !session || !session.macBytes) {
      throw new NotConnectedError();
    }
    if (allowStale) {
      return session;
    }
    const status = this.lastStatusReport;
    const ageMs = status ? Date.now() - status.receivedAtMs : Number.POSITIVE_INFINITY;
    if (!status || status.sessionId !== session.sessionId || ageMs < 0 || ageMs > this.statusMaxAgeMs) {
      throw new StaleLocalStatusError();
    }
    return session;
  }

  private nextTimestamp(): number {
    let ts = Math.floor(Date.now() / 1000);
    if (this.lastOutboundTimestampSec !== null) {
      ts = Math.max(ts, this.lastOutboundTimestampSec + 1);
    }
    this.lastOutboundTimestampSec = ts;
    return ts;
  }

  private enqueueSend(
    session: ActiveSession,
    opcode: number,
    data: Buffer,
    paceAndTrack: boolean,
    pending?: PendingLocalCommand,
    allowStale = false,
  ): Promise<void> {
    const run = async () => {
      if (this.closing || this.session !== session || session.socket.destroyed || !session.macBytes) {
        throw new NotConnectedError('Connection closed before sending');
      }

      if (paceAndTrack && this.lastOutboundTimeMs !== null) {
        const elapsed = Date.now() - this.lastOutboundTimeMs;
        const waitMs = Math.max(0, COMMAND_SPACING_MS - elapsed);
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }

      if (this.closing || this.session !== session || session.socket.destroyed || !session.macBytes) {
        throw new NotConnectedError('Connection closed before sending');
      }

      if (pending) {
        this.requireFreshSession(allowStale);
        if (opcode === 0x23 && !allowStale && (!this.lastStatusReport || this.lastStatusReport.power !== true)) {
          throw new LocalServerError('Appliance must report enabled before changing humidity');
        }
      }

      const timestamp = this.nextTimestamp();
      const raw = opcode === 0x01 && !paceAndTrack
        ? buildKeepaliveReply(session.macBytes, timestamp)
        : encodeNativeFrame({
          macBytes: session.macBytes,
          timestamp,
          fn: 0x09,
          opcode,
          data,
        });

      if (pending) {
        pending.receiveSequence = session.receiveSequence;
        pending.byteBoundary = session.totalBytesReceived;
        pending.queued = true;
      }

      await new Promise<void>((resolve, reject) => {
        session.socket.write(raw, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      this.lastOutboundTimeMs = Date.now();
    };

    const next = this.sendChain.then(run, run);
    this.sendChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private executeSerializedCommand(
    opcode: number,
    buildPayload: (session: ActiveSession, ts: number) => Buffer,
    expectedValue: unknown,
    allowStale = false,
  ): Promise<LocalStatusReport> {
    const run = async (): Promise<LocalStatusReport> => {
      const session = this.requireFreshSession(allowStale);
      if (!session.macBytes) {
        throw new NotConnectedError();
      }
      // Validate payload construction before queueing
      const samplePayload = buildPayload(session, Math.floor(Date.now() / 1000));
      const dataOnly = samplePayload.subarray(26, samplePayload.length - 3);

      return await new Promise<LocalStatusReport>((resolve, reject) => {
        const pending: PendingLocalCommand = {
          opcode,
          expectedValue,
          queued: false,
          receiveSequence: 0,
          byteBoundary: 0,
          resolve,
          reject,
        };
        session.pending = pending;

        pending.timer = setTimeout(() => {
          if (session.pending === pending) {
            session.pending = null;
          }
          reject(
            pending.queued
              ? new CommandUncertainError('timeout')
              : new LocalServerError('Command deadline expired before bytes were queued'),
          );
        }, this.commandTimeoutMs);

        this.enqueueSend(session, opcode, dataOnly, true, pending, allowStale).catch((err) => {
          if (session.pending === pending) {
            session.pending = null;
          }
          if (pending.timer) {
            clearTimeout(pending.timer);
          }
          reject(
            pending.queued
              ? new CommandUncertainError('write_error')
              : (err instanceof Error ? err : new LocalServerError(String(err))),
          );
        });
      });
    };

    const next = this.commandChain.then(run, run);
    this.commandChain = next.then(() => undefined, () => undefined);
    return next;
  }

  public async setPower(on: boolean): Promise<LocalStatusReport> {
    // Safety OFF is permitted on a verified connected session even if status became stale.
    return this.executeSerializedCommand(
      0x21,
      (s, ts) => buildPowerCommand(s.macBytes!, on, ts),
      on,
      on === false,
    );
  }

  public async setHumidity(target: number, allowStale = false): Promise<LocalStatusReport> {
    return this.executeSerializedCommand(
      0x23,
      (s, ts) => buildHumidityCommand(s.macBytes!, target, ts, s.profile),
      target,
      allowStale,
    );
  }

  public async setTemperatureUnit(unit: TemperatureDisplayUnit): Promise<LocalStatusReport> {
    return this.executeSerializedCommand(
      0x24,
      (s, ts) => buildTemperatureUnitCommand(s.macBytes!, unit, ts),
      unit,
      false,
    );
  }

  public async purge(): Promise<LocalStatusReport> {
    return this.executeSerializedCommand(
      0x22,
      (s, ts) => buildPurgeCommand(s.macBytes!, ts),
      true,
      false,
    );
  }

  public async setLocate(on: boolean): Promise<LocalStatusReport> {
    return this.executeSerializedCommand(
      0x27,
      (s, ts) => buildLocateCommand(s.macBytes!, on, ts),
      on,
      false,
    );
  }

  public async close(): Promise<void> {
    this.closing = true;
    if (this.session) {
      this.session.socket.destroy();
      this.session = null;
    }
    this.lastStatusReport = null;
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
      });
    }
  }
}

