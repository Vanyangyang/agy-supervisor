import { randomBytes, randomUUID, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { mkdir, open, readFile, chmod, unlink, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const SUPERVISOR_PROTOCOL_VERSION = 1;
export const SUPERVISOR_RUNTIME_VERSION = '0.2.0';

export function getSupervisorPaths({ localAppData, stateDir: requestedStateDir, userName, homeDir } = {}) {
  const user = String(userName || process.env.USERNAME || userInfo().username);
  const stateDir = resolve(requestedStateDir
    || (localAppData ? join(localAppData, 'agy-supervisor') : join(homeDir || homedir(), '.agy-supervisor')));
  const identity = createHash('sha256').update(`${stateDir.toLowerCase()}\0${user.toLowerCase()}`).digest('hex').slice(0, 32);
  const socketBasePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\LOCAL\\agy-supervisor-${identity}`
    : join(stateDir, `supervisor-${identity}.sock`);
  return {
    stateDir,
    socketBasePath,
    socketPath: socketBasePath,
    tokenPath: join(stateDir, 'supervisor.token'),
    epochPath: join(stateDir, 'supervisor.epoch'),
    bootstrapEnvPath: join(stateDir, 'bootstrap-env.json'),
    launchLockPath: join(stateDir, 'supervisor.launch.lock'),
  };
}

export function resolveSupervisorPaths(paths, token) {
  const base = paths.socketBasePath || paths.socketPath;
  const suffix = createHmac('sha256', Buffer.from(token, 'hex'))
    .update(String(base).toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, 24);
  const socketPath = process.platform === 'win32'
    ? `${base}-${suffix}`
    : join(paths.stateDir, `supervisor-${suffix}.sock`);
  return { ...paths, socketBasePath: base, socketPath };
}

function validToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

export async function ensureSupervisorToken(paths) {
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await chmod(paths.stateDir, 0o700).catch(() => {});
  try {
    const existing = (await readFile(paths.tokenPath, 'utf8')).trim();
    if (!validToken(existing)) throw new Error('invalid-token-file');
    await chmod(paths.tokenPath, 0o600).catch(() => {});
    return existing;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const created = randomBytes(32).toString('hex');
  try {
    const handle = await open(paths.tokenPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${created}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    return created;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const winner = (await readFile(paths.tokenPath, 'utf8')).trim();
    if (!validToken(winner)) throw new Error('invalid-token-file');
    return winner;
  }
}

function signEnvelope(token, payload) {
  return createHmac('sha256', Buffer.from(token, 'hex')).update(JSON.stringify(payload), 'utf8').digest('hex');
}

function withMac(token, payload) {
  return { ...payload, mac: signEnvelope(token, payload) };
}

function macMatches(token, message) {
  const presented = typeof message?.mac === 'string' && /^[0-9a-f]{64}$/u.test(message.mac)
    ? Buffer.from(message.mac, 'hex')
    : Buffer.alloc(32);
  const unsigned = message && typeof message === 'object' && !Array.isArray(message) ? { ...message } : {};
  delete unsigned.mac;
  let expected;
  try {
    expected = Buffer.from(signEnvelope(token, unsigned), 'hex');
  } catch {
    expected = Buffer.alloc(32);
  }
  return timingSafeEqual(expected, presented);
}

function responseError(kind, epoch, id = null) {
  return { id, epoch, ok: false, error: { kind } };
}

function handlerErrorKind(error) {
  const value = error?.kind || error?.code;
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(value)
    ? value
    : 'handler_failed';
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function validMethod(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

async function socketIsLive(socketPath) {
  return new Promise((resolveLive) => {
    const socket = net.createConnection(socketPath);
    const done = (live) => {
      socket.destroy();
      resolveLive(live);
    };
    socket.setTimeout(150, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function listenLocal(server, paths) {
  const listen = () => new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(paths.socketPath);
  });

  try {
    await listen();
  } catch (error) {
    if (process.platform === 'win32' || error?.code !== 'EADDRINUSE' || await socketIsLive(paths.socketPath)) throw error;
    await unlink(paths.socketPath).catch((unlinkError) => {
      if (unlinkError?.code !== 'ENOENT') throw unlinkError;
    });
    await listen();
  }
}

export async function createSupervisorServer({ paths, token, epoch, handleRequest, pingResult = () => ({ ready: true }) }) {
  if (!paths?.stateDir || !paths?.socketPath || !paths?.epochPath) throw new TypeError('invalid-paths');
  if (!validToken(token)) throw new TypeError('invalid-token');
  const generation = String(epoch || '');
  if (!generation || generation.length > 128) throw new TypeError('invalid-epoch');
  if (typeof handleRequest !== 'function') throw new TypeError('invalid-handler');

  const resolvedPaths = resolveSupervisorPaths(paths, token);
  await mkdir(resolvedPaths.stateDir, { recursive: true, mode: 0o700 });
  await chmod(resolvedPaths.stateDir, 0o700).catch(() => {});
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let writeTail = Promise.resolve();
    let closedForSize = false;

    const send = (message, end = false) => {
      let encoded;
      try {
        encoded = `${JSON.stringify(withMac(token, message))}\n`;
      } catch {
        encoded = `${JSON.stringify(withMac(token, responseError('handler_failed', generation, message?.id ?? null)))}\n`;
      }
      if (Buffer.byteLength(encoded, 'utf8') - 1 > MAX_MESSAGE_BYTES) {
        encoded = `${JSON.stringify(withMac(token, responseError('oversized', generation, message?.id ?? null)))}\n`;
      }
      writeTail = writeTail.then(() => new Promise((resolveWrite) => {
        if (socket.destroyed) return resolveWrite();
        socket.write(encoded, () => {
          if (end) socket.end();
          resolveWrite();
        });
      })).catch(() => {});
      return writeTail;
    };

    const processLine = async (line) => {
      let message;
      try {
        message = JSON.parse(line.toString('utf8'));
      } catch {
        macMatches(token, null);
        await send(responseError('malformed', generation));
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        macMatches(token, null);
        await send(responseError('malformed', generation));
        return;
      }
      const id = validId(message.id) ? message.id : null;
      if (!macMatches(token, message)) {
        await send(responseError('unauthorized', generation, id));
        return;
      }
      if (!validId(message.id) || typeof message.epoch !== 'string' || !validMethod(message.method)) {
        await send(responseError('malformed', generation, id));
        return;
      }
      if (message.epoch !== generation) {
        await send(responseError('stale_epoch', generation, message.id));
        return;
      }
      if (message.method === 'ping') {
        const custom = await pingResult();
        await send({
          id: message.id,
          epoch: generation,
          ok: true,
          result: {
            ...(custom && typeof custom === 'object' ? custom : {}),
            protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
            runtimeVersion: SUPERVISOR_RUNTIME_VERSION,
          },
        });
        return;
      }
      try {
        const result = await handleRequest({
          id: message.id,
          epoch: message.epoch,
          method: message.method,
          params: message.params,
        });
        await send({ id: message.id, epoch: generation, ok: true, result: result ?? null });
      } catch (error) {
        await send(responseError(handlerErrorKind(error), generation, message.id));
      }
    };

    socket.on('data', (chunk) => {
      if (closedForSize) return;
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          if (buffer.length > MAX_MESSAGE_BYTES) {
            closedForSize = true;
            macMatches(token, null);
            void send(responseError('oversized', generation), true);
          }
          return;
        }
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length > MAX_MESSAGE_BYTES) {
          closedForSize = true;
          macMatches(token, null);
          void send(responseError('oversized', generation), true);
          return;
        }
        if (line.length === 0) continue;
        void processLine(line);
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });

  await listenLocal(server, resolvedPaths);
  server.on('error', () => {});
  await writeFile(resolvedPaths.epochPath, `${generation}\n`, { encoding: 'utf8', mode: 0o600 });

  let closing;
  const close = () => {
    if (closing) return closing;
    closing = new Promise((resolveClose) => {
      for (const socket of sockets) socket.destroy();
      server.close(async () => {
        if (process.platform !== 'win32') await unlink(resolvedPaths.socketPath).catch(() => {});
        resolveClose();
      });
    });
    return closing;
  };
  return { server, paths: resolvedPaths, epoch: generation, close };
}

function transportFailure(kind) {
  const error = new Error(kind);
  error.kind = kind;
  return error;
}

export async function requestSupervisor({ paths, token, request, timeoutMs = 5_000 }) {
  if (!validToken(token)) throw transportFailure('invalid_token');
  const resolvedPaths = resolveSupervisorPaths(paths, token);
  let epoch = request?.epoch;
  if (epoch == null) {
    try {
      epoch = (await readFile(resolvedPaths.epochPath, 'utf8')).trim();
    } catch {
      throw transportFailure('unavailable');
    }
  }
  const id = request?.id ?? randomUUID();
  const { mac: _ignoredMac, token: _ignoredToken, ...requestFields } = request || {};
  const payload = withMac(token, { ...requestFields, id, epoch });
  let encoded;
  try {
    encoded = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    throw transportFailure('malformed_request');
  }
  if (encoded.length - 1 > MAX_MESSAGE_BYTES) throw transportFailure('oversized');

  return new Promise((resolveRequest, rejectRequest) => {
    const socket = net.createConnection(resolvedPaths.socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectRequest(error);
      else resolveRequest(value);
    };
    const timer = setTimeout(() => finish(transportFailure('timeout')), Math.max(1, Number(timeoutMs) || 1));
    socket.once('connect', () => socket.write(encoded));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.length > MAX_MESSAGE_BYTES) finish(transportFailure('oversized'));
        return;
      }
      if (newline > MAX_MESSAGE_BYTES) return finish(transportFailure('oversized'));
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        if (!macMatches(token, response)) return finish(transportFailure('unauthenticated_response'));
        if (!response || typeof response !== 'object' || Array.isArray(response)
          || response.id !== id || response.epoch !== epoch || typeof response.ok !== 'boolean'
          || (!response.ok && (typeof response.error?.kind !== 'string' || !response.error.kind))) {
          throw new Error('bad-response');
        }
        finish(null, response);
      } catch {
        finish(transportFailure('malformed_response'));
      }
    });
    socket.once('error', () => finish(transportFailure('unavailable')));
    socket.once('end', () => finish(transportFailure('unavailable')));
  });
}
