import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  MAX_MESSAGE_BYTES,
  createSupervisorServer,
  ensureSupervisorToken,
  getSupervisorPaths,
  requestSupervisor,
  resolveSupervisorPaths,
  SUPERVISOR_PROTOCOL_VERSION,
  SUPERVISOR_RUNTIME_VERSION,
} from './supervisor-transport.mjs';
import { SupervisorClient } from './supervisor-client.mjs';
import {
  buildDesktopShellCreateScript,
  buildWindowsCommandLine,
} from './win-job-breakaway.mjs';

async function fixture(handleRequest = async (request) => request.params) {
  const root = await mkdtemp(join(tmpdir(), 'agy-supervisor-test-'));
  const paths = getSupervisorPaths({ localAppData: root, userName: 'test-user' });
  const token = await ensureSupervisorToken(paths);
  const epoch = 'test-epoch';
  const server = await createSupervisorServer({ paths, token, epoch, handleRequest });
  return {
    paths: server.paths,
    token,
    epoch,
    server,
    async close() {
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function rawRequest(socketPath, bytes) {
  return new Promise((resolveRaw, rejectRaw) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(bytes));
    socket.on('data', (chunk) => {
      data += chunk;
      const newline = data.indexOf('\n');
      if (newline >= 0) {
        socket.destroy();
        resolveRaw(JSON.parse(data.slice(0, newline)));
      }
    });
    socket.once('error', rejectRaw);
  });
}

test('supervisor paths are deterministic per state root and user', () => {
  const first = getSupervisorPaths({ localAppData: 'C:/State Root', userName: 'Alice' });
  const second = getSupervisorPaths({ localAppData: 'C:/State Root', userName: 'Alice' });
  const other = getSupervisorPaths({ localAppData: 'C:/State Root', userName: 'Bob' });
  assert.deepEqual(first, second);
  assert.notEqual(first.socketPath, other.socketPath);
  assert.ok(first.tokenPath.startsWith(first.stateDir));
});

test('default supervisor state avoids packaged LocalAppData virtualization', () => {
  const paths = getSupervisorPaths({ homeDir: 'C:/Users/Alice', userName: 'Alice' });
  assert.equal(paths.stateDir, resolve('C:/Users/Alice/.agy-supervisor'));
});

test('accepts a valid token and rejects a wrong token', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const valid = await requestSupervisor({
    paths: f.paths,
    token: f.token,
    request: { id: 'valid', epoch: f.epoch, method: 'echo', params: { value: 7 } },
  });
  assert.deepEqual(valid.result, { value: 7 });
  await assert.rejects(requestSupervisor({
    paths: f.paths,
    token: '0'.repeat(64),
    request: { id: 'wrong', epoch: f.epoch, method: 'echo' },
  }), (error) => error.kind === 'unavailable');
  const ping = await requestSupervisor({
    paths: f.paths,
    token: f.token,
    request: { id: 'ping', epoch: f.epoch, method: 'ping' },
  });
  assert.equal(ping.result.protocolVersion, SUPERVISOR_PROTOCOL_VERSION);
  assert.equal(ping.result.runtimeVersion, SUPERVISOR_RUNTIME_VERSION);
});

test('client rejects a response from the wrong daemon epoch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agy-supervisor-epoch-test-'));
  const basePaths = getSupervisorPaths({ localAppData: root, userName: 'test-user' });
  const token = await ensureSupervisorToken(basePaths);
  const paths = resolveSupervisorPaths(basePaths, token);
  await writeFile(paths.epochPath, 'right-epoch\n', 'utf8');
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      const request = JSON.parse(chunk.toString('utf8').trim());
      const response = { id: request.id, epoch: 'wrong-epoch', ok: true, result: {} };
      response.mac = createHmac('sha256', Buffer.from(token, 'hex')).update(JSON.stringify(response), 'utf8').digest('hex');
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise((resolveListen) => server.listen(paths.socketPath, resolveListen));
  t.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    requestSupervisor({ paths, token, request: { method: 'ping' } }),
    (error) => error.kind === 'malformed_response',
  );
});

test('rejects malformed and oversized messages with fixed error kinds', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const malformed = await rawRequest(f.paths.socketPath, '{not json}\n');
  assert.equal(malformed.error.kind, 'malformed');
  const oversized = await rawRequest(f.paths.socketPath, Buffer.concat([
    Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x61),
    Buffer.from('\n'),
  ]));
  assert.equal(oversized.error.kind, 'oversized');
});

test('client timeout does not send remote cancellation', async (t) => {
  let completed = false;
  const f = await fixture(async () => {
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    completed = true;
    return 'done';
  });
  t.after(() => f.close());
  await assert.rejects(requestSupervisor({
    paths: f.paths,
    token: f.token,
    request: { id: 'slow', epoch: f.epoch, method: 'slow' },
    timeoutMs: 20,
  }), (error) => error.kind === 'timeout');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(completed, true);
});

test('inspect wait extends the local RPC deadline without changing other calls', async (t) => {
  const f = await fixture(async () => {
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    return { revision: 2 };
  });
  t.after(() => f.close());
  const client = new SupervisorClient({ paths: f.paths, token: f.token, timeoutMs: 20 });
  assert.deepEqual(await client.inspect({ afterRevision: 1, waitMs: 100 }), { revision: 2 });
});

test('Windows desktop-shell launch quotes arguments without shell interpolation', () => {
  const command = buildWindowsCommandLine('C:\\Program Files\\node.exe', [
    'C:\\state root\\daemon "safe".mjs',
    '--state-dir',
    "C:\\Users\\O'Brien\\state\\",
  ]);
  assert.match(command, /^"C:\\Program Files\\node\.exe"/u);
  assert.ok(command.includes('\\"safe\\"'));
  const script = buildDesktopShellCreateScript(
    'C:\\Program Files\\node.exe',
    'C:\\state root\\daemon "safe".mjs',
    ['--state-dir', "C:\\Users\\O'Brien\\state\\"],
    "C:\\Users\\O'Brien",
  );
  assert.ok(script.includes("O''Brien"));
  assert.ok(script.includes('FindWindowSW'));
  assert.ok(script.includes('ShellExecute'));
  assert.ok(!script.includes('Win32_Process.Create'));
  assert.ok(!script.includes('supervisor.token'));
});
