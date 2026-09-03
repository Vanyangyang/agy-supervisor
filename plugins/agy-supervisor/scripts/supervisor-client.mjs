import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { buildSafeAgyEnvironment } from './agy-runtime.mjs';
import { launchDetachedNode } from './win-job-breakaway.mjs';
import { processIsAlive } from './process-identity.mjs';
import {
  ensureSupervisorToken,
  getSupervisorPaths,
  requestSupervisor,
  SUPERVISOR_PROTOCOL_VERSION,
  SUPERVISOR_RUNTIME_VERSION,
} from './supervisor-transport.mjs';

function clientFailure(kind) {
  const error = new Error(kind);
  error.kind = kind;
  return error;
}

export class SupervisorClient {
  constructor({ paths = getSupervisorPaths(), token, timeoutMs = 5_000 } = {}) {
    this.paths = paths;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(method, params, timeoutMs = this.timeoutMs) {
    let token = this.token;
    if (!token) {
      try {
        token = (await readFile(this.paths.tokenPath, 'utf8')).trim();
      } catch {
        throw clientFailure('unavailable');
      }
    }
    const response = await requestSupervisor({
      paths: this.paths,
      token,
      request: { method, params },
      timeoutMs,
    });
    if (!response.ok) throw clientFailure(response.error?.kind || 'remote_error');
    return response.result;
  }

  ping() { return this.request('ping'); }
  startTurn(params) { return this.request('startTurn', params); }
  inspect(params) {
    const waitMs = Math.max(0, Math.min(25_000, Number(params?.waitMs) || 0));
    return this.request('inspect', params, Math.max(this.timeoutMs, waitMs + 1_000));
  }
  control(params) { return this.request('control', params); }
  detach() { return { detached: true, cancelled: false }; }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function writeBootstrapEnvironment(paths) {
  const temporary = `${paths.bootstrapEnvPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(buildSafeAgyEnvironment(process.env))}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, paths.bootstrapEnvPath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function assertCompatiblePing(result) {
  if (result?.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION) throw clientFailure('protocol_mismatch');
  if (result?.runtimeVersion !== SUPERVISOR_RUNTIME_VERSION) throw clientFailure('runtime_version_mismatch');
  if (result?.ready !== true) throw clientFailure('daemon_starting');
  return result;
}

async function pingUntilReady(client, deadline) {
  while (Date.now() < deadline) {
    try {
      return assertCompatiblePing(await client.ping());
    } catch (error) {
      if (error?.kind === 'protocol_mismatch' || error?.kind === 'runtime_version_mismatch') throw error;
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  throw clientFailure('startup_timeout');
}

export async function ensureSupervisorRunning({
  paths = getSupervisorPaths(),
  daemonEntry,
  timeoutMs = 5_000,
  launch = launchDetachedNode,
} = {}) {
  const token = await ensureSupervisorToken(paths);
  await writeBootstrapEnvironment(paths);
  const client = new SupervisorClient({ paths, token, timeoutMs: Math.min(500, timeoutMs) });
  try {
    assertCompatiblePing(await client.ping());
    client.timeoutMs = timeoutMs;
    return { client, launched: false };
  } catch (error) {
    if (error?.kind === 'protocol_mismatch' || error?.kind === 'runtime_version_mismatch') throw error;
  }
  if (!daemonEntry) throw clientFailure('daemon_entry_required');

  let lock;
  try {
    lock = await open(paths.launchLockPath, 'wx', 0o600);
    await lock.writeFile(`${process.pid}\n`, 'utf8');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw clientFailure('launch_lock_failed');
    try {
      const ownerText = (await readFile(paths.launchLockPath, 'utf8')).trim();
      const ownerPid = Number(ownerText);
      if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw clientFailure('launch_lock_unverifiable');
      if (!processIsAlive(ownerPid)) {
        await unlink(paths.launchLockPath);
        lock = await open(paths.launchLockPath, 'wx', 0o600);
        await lock.writeFile(`${process.pid}\n`, 'utf8');
      }
    } catch (recoveryError) {
      if (recoveryError?.kind) throw recoveryError;
      if (recoveryError?.code === 'ENOENT') {
        try {
          lock = await open(paths.launchLockPath, 'wx', 0o600);
          await lock.writeFile(`${process.pid}\n`, 'utf8');
        } catch (retryError) {
          if (retryError?.code !== 'EEXIST') throw clientFailure('launch_lock_failed');
        }
      } else if (recoveryError?.code !== 'EEXIST') {
        throw clientFailure('launch_lock_failed');
      }
    }
  }

  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1);
  try {
    if (lock) {
      const launchResult = launch(daemonEntry, ['--state-dir', paths.stateDir], { cwd: paths.stateDir });
      if (!launchResult?.ok) throw clientFailure(launchResult?.errorKind || 'launch_failed');
    }
    await pingUntilReady(client, deadline);
    client.timeoutMs = timeoutMs;
    return { client, launched: Boolean(lock) };
  } finally {
    if (lock) {
      await lock.close().catch(() => {});
      await unlink(paths.launchLockPath).catch(() => {});
    }
  }
}
