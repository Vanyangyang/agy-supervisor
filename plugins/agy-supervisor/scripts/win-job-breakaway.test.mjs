import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDesktopShellCreateScript,
  buildWindowsCommandLine,
  classifyWindowsLaunchError,
  launchDetachedNode,
  resolveWindowsPowerShell,
} from './win-job-breakaway.mjs';

test('resolves the absolute system PowerShell path when it exists', () => {
  const resolved = resolveWindowsPowerShell(
    { SystemRoot: 'D:\\Windows' },
    (candidate) => candidate === 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(resolved, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('classifies a missing PowerShell executable without exposing stderr', () => {
  const error = Object.assign(new Error('spawn failed'), { code: 'ENOENT', stderr: 'private details' });
  assert.deepEqual(classifyWindowsLaunchError(error), {
    errorKind: 'launch_powershell_not_found',
    errorCode: 'ENOENT',
  });
});

test('launches through the interactive desktop shell without a WMI fallback', () => {
  let calls = 0;
  const result = launchDetachedNode('C:\\plugin\\daemon.mjs', ['--state-dir', 'C:\\state'], {
    platform: 'win32',
    cwd: 'C:\\state',
    powerShellPath: 'C:\\Windows\\powershell.exe',
    execFileSyncImpl: (_file, args) => {
      calls += 1;
      assert.match(args.at(-1), /FindWindowSW/u);
      assert.match(args.at(-1), /ShellExecute/u);
      return 'started\n';
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    ok: true,
    method: 'explorer-desktop-shell',
    pid: null,
    commandLine: buildWindowsCommandLine(process.execPath, ['C:\\plugin\\daemon.mjs', '--state-dir', 'C:\\state']),
    attempts: 1,
  });
});

test('does not retry a policy-blocked desktop-shell launch', () => {
  let calls = 0;
  const result = launchDetachedNode('C:\\plugin\\daemon.mjs', [], {
    platform: 'win32',
    cwd: 'C:\\state',
    powerShellPath: 'C:\\Windows\\powershell.exe',
    execFileSyncImpl: () => {
      calls += 1;
      throw Object.assign(new Error('blocked'), { code: 'EPERM' });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, 'launch_policy_blocked');
  assert.equal(result.attempts, 1);
});

test('desktop-shell script does not contain state secrets or WMI process creation', () => {
  const script = buildDesktopShellCreateScript(
    'C:\\Program Files\\nodejs\\node.exe',
    "C:\\Users\\O'Brien\\daemon.mjs",
    ['--state-dir', 'C:\\state'],
    'C:\\state',
  );
  assert.ok(script.includes("O''Brien"));
  assert.ok(!script.includes('supervisor.token'));
  assert.ok(!script.includes('Win32_Process.Create'));
});
