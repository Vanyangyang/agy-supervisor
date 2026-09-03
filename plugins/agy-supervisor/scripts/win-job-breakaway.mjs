import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function quoteWindowsArgument(value) {
  const input = String(value);
  if (input === '') return '""';
  if (!/[\s"]/u.test(input)) return input;
  let output = '"';
  let slashes = 0;
  for (const character of input) {
    if (character === '\\') {
      slashes += 1;
    } else if (character === '"') {
      output += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
    } else {
      output += '\\'.repeat(slashes) + character;
      slashes = 0;
    }
  }
  return output + '\\'.repeat(slashes * 2) + '"';
}

export function buildWindowsCommandLine(file, args = []) {
  return [file, ...args].map(quoteWindowsArgument).join(' ');
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildDesktopShellCreateScript(nodePath, daemonEntry, args, cwd) {
  const parameters = [daemonEntry, ...args].map(quoteWindowsArgument).join(' ');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$nodePath = ${quotePowerShellLiteral(nodePath)}`,
    `$parameters = ${quotePowerShellLiteral(parameters)}`,
    `$workingDirectory = ${quotePowerShellLiteral(cwd)}`,
    '$shell = New-Object -ComObject Shell.Application',
    '$location = 0; $root = 0; $hwnd = 0',
    '$desktop = $shell.Windows().FindWindowSW([ref]$location, [ref]$root, 8, [ref]$hwnd, 1)',
    "if ($null -eq $desktop) { throw 'interactive-shell-unavailable' }",
    "$desktop.Document.Application.ShellExecute($nodePath, $parameters, $workingDirectory, 'open', 0)",
    "Write-Output 'started'",
  ].join('\n');
}

export function resolveWindowsPowerShell(env = process.env, exists = existsSync) {
  const systemRoot = env.SystemRoot || env.WINDIR;
  if (systemRoot) {
    const candidate = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (exists(candidate)) return candidate;
  }
  return 'powershell.exe';
}

function launchErrorText(error) {
  return [error?.message, error?.stderr]
    .filter((value) => value != null && String(value).trim())
    .map(String)
    .join('\n');
}

export function classifyWindowsLaunchError(error) {
  const message = launchErrorText(error);
  const code = error?.code == null ? null : String(error.code);
  if (/interactive-shell-unavailable/iu.test(message)) return { errorKind: 'launch_interactive_shell_unavailable', errorCode: code };
  if (code === 'ENOENT') return { errorKind: 'launch_powershell_not_found', errorCode: code };
  if (code === 'EPERM' || code === 'EACCES' || /0x80070005|access.*denied|拒绝访问/iu.test(message)) {
    return { errorKind: 'launch_policy_blocked', errorCode: code || 'E_ACCESSDENIED' };
  }
  if (code === 'ETIMEDOUT' || error?.killed === true) return { errorKind: 'launch_timeout', errorCode: code || 'ETIMEDOUT' };
  return { errorKind: 'launch_failed', errorCode: code };
}

export function launchDetachedNode(daemonEntry, args = [], options = {}) {
  const nodePath = options.nodePath || process.execPath;
  const cwd = options.cwd || dirname(daemonEntry);
  const platform = options.platform || process.platform;
  const commandLine = buildWindowsCommandLine(nodePath, [daemonEntry, ...args]);
  if (platform !== 'win32') {
    try {
      const child = (options.spawnImpl || spawn)(nodePath, [daemonEntry, ...args], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return { ok: true, method: 'detached-spawn', pid: child.pid, commandLine };
    } catch {
      return { ok: false, errorKind: 'launch_failed' };
    }
  }

  const run = options.execFileSyncImpl || execFileSync;
  const powerShellPath = options.powerShellPath
    || resolveWindowsPowerShell(options.env || process.env, options.existsSyncImpl || existsSync);
  try {
    const output = run(powerShellPath, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', buildDesktopShellCreateScript(nodePath, daemonEntry, args, cwd),
    ], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim();
    if (output.split(/\r?\n/u).at(-1) !== 'started') throw new Error('unexpected desktop shell output');
    return { ok: true, method: 'explorer-desktop-shell', pid: null, commandLine, attempts: 1 };
  } catch (error) {
    return { ok: false, ...classifyWindowsLaunchError(error), attempts: 1 };
  }
}
