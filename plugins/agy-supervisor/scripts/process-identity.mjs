import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

function execFile(file, args, options) {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function inspectProcessIdentity(pid, {
  platform = process.platform,
  execFileImpl = execFile,
  env = process.env,
} = {}) {
  if (!processIsAlive(pid)) return { alive: false, fingerprint: null };
  if (platform !== "win32") return { alive: true, fingerprint: null };
  const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    `$item = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if ($null -eq $item) { exit 3 }",
    "$created = if ($item.CreationDate) { $item.CreationDate.ToUniversalTime().ToString('o') } else { $null }",
    "[pscustomobject]@{ Name = $item.Name; ExecutablePath = $item.ExecutablePath; CreatedAt = $created; CommandLine = $item.CommandLine } | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const output = await execFileImpl(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
      maxBuffer: 64 * 1024,
    });
    const raw = JSON.parse(output);
    const identity = {
      name: typeof raw.Name === "string" ? raw.Name : null,
      executablePath: typeof raw.ExecutablePath === "string" ? raw.ExecutablePath : null,
      createdAt: typeof raw.CreatedAt === "string" ? raw.CreatedAt : null,
      commandLineSha256: createHash("sha256").update(String(raw.CommandLine || ""), "utf8").digest("hex"),
    };
    return {
      alive: true,
      executablePath: identity.executablePath,
      createdAt: identity.createdAt,
      fingerprint: createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex"),
    };
  } catch {
    return processIsAlive(pid)
      ? { alive: true, fingerprint: null }
      : { alive: false, fingerprint: null };
  }
}
