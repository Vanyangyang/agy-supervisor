import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { win32 } from "node:path";

export const SUPPORTED_AGY_VERSION = "1.1.25";
export const SUPPORTED_AGY_SHA256 = "DBC665F942B59E56A0D3317AA01B93ACC9521BDAA76277B922D82EF90EBA2B3C";
export const EXPECTED_AGY_SIGNER = "Google LLC";
export const DEFAULT_AGY_MODEL = "gemini-3.8-flash";
export const DEFAULT_AGY_EFFORT = "high";
export const SUPPORTED_AGY_EFFORTS = Object.freeze(["low", "medium", "high"]);
export const REQUIRED_AGY_HELP_FLAGS = Object.freeze([
  "--input-format",
  "--output-format",
  "--conversation",
  "--model",
  "--effort",
  "--sandbox",
  "--dangerously-skip-permissions",
]);
export const AGY_STDERR_KINDS = Object.freeze({
  AUTH_REQUIRED_IN_USER_TERMINAL: "AUTH_REQUIRED_IN_USER_TERMINAL",
  KEYRING_UNAVAILABLE: "KEYRING_UNAVAILABLE",
  RUNTIME_ERROR: "RUNTIME_ERROR",
});

const MAX_RUNTIME_OUTPUT_BYTES = 64 * 1024;
const RUNTIME_TIMEOUT_MS = 5_000;
const WINDOWS_INTERNET_SETTINGS_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`;
const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  "ALLUSERSPROFILE",
  "APPDATA",
  "CLIENTNAME",
  "COMPUTERNAME",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGONSERVER",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PUBLIC",
  "SESSIONNAME",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TZ",
  "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);
const SECRET_NAME = /(?:api[_-]?key|token|secret|pass(?:word|phrase)?|credential|auth(?:entication|orization)?|private[_-]?key)/i;

function normalizedEnvironment(sourceEnv) {
  const values = new Map();
  for (const [key, value] of Object.entries(sourceEnv || {})) {
    if (typeof value === "string") values.set(key.toUpperCase(), value);
  }
  return values;
}

function safeEnvironmentValue(key, value) {
  if (!/_PROXY$/i.test(key)) return value;
  try {
    const parsed = new URL(value);
    return parsed.username || parsed.password ? null : value;
  } catch {
    return value.includes("@") ? null : value;
  }
}

export function buildSafeAgyEnvironment(sourceEnv = process.env) {
  const source = normalizedEnvironment(sourceEnv);
  const safe = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const normalizedKey = key.toUpperCase();
    const value = source.get(normalizedKey);
    if (typeof value === "string" && !SECRET_NAME.test(key)) {
      const accepted = safeEnvironmentValue(normalizedKey, value);
      if (accepted !== null) safe[normalizedKey] = accepted;
    }
  }
  safe.CI = "true";
  safe.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  return safe;
}

export function defaultAgyPath({ env = process.env, platform = process.platform } = {}) {
  const localAppData = Object.entries(env || {}).find(([key, value]) => key.toUpperCase() === "LOCALAPPDATA" && typeof value === "string")?.[1];
  if (platform !== "win32" || typeof localAppData !== "string" || !localAppData.trim()) {
    return null;
  }
  return win32.join(localAppData, "agy", "bin", "agy.exe");
}

export function classifyAgyStderr(stderr) {
  const text = String(stderr || "");
  if (/(keyring|keychain|credential manager|secure storage|secret service)/i.test(text)) {
    return AGY_STDERR_KINDS.KEYRING_UNAVAILABLE;
  }
  if (/(sign[ -]?in|log[ -]?in|authenticate|authentication|required.*(?:account|auth)|unauthenticated|authorization required)/i.test(text)) {
    return AGY_STDERR_KINDS.AUTH_REQUIRED_IN_USER_TERMINAL;
  }
  return AGY_STDERR_KINDS.RUNTIME_ERROR;
}

function boundedText(value) {
  const text = typeof value === "string" ? value : "";
  return Buffer.byteLength(text, "utf8") <= MAX_RUNTIME_OUTPUT_BYTES ? text : null;
}

function invokePathFunction(fn, path) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    try {
      const returned = fn(path, done);
      if (returned && typeof returned.then === "function") {
        returned.then((value) => done(null, value), done);
      } else if (fn.length < 2) {
        done(null, returned);
      }
    } catch (error) {
      done(error);
    }
  });
}

function invokeExecFile(execFile, file, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject({ stderr: boundedText(stderr ?? error.stderr), error });
      } else {
        resolve({ stdout: boundedText(stdout), stderr: boundedText(stderr) });
      }
    };
    try {
      const returned = execFile(file, args, options, done);
      if (returned && typeof returned.then === "function") {
        returned.then(
          (value) => done(null, value?.stdout ?? value, value?.stderr),
          (error) => done(error, error?.stdout, error?.stderr),
        );
      }
    } catch (error) {
      done(error, error?.stdout, error?.stderr);
    }
  });
}

function safeProxyEndpoint(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.includes("@")) return null;
  try {
    const parsed = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(raw) ? raw : `http://${raw}`);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    if (!parsed.hostname || (parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function parseWindowsProxyServer(proxyServer, { enabled = true } = {}) {
  if (!enabled || typeof proxyServer !== "string" || !proxyServer.trim()) return {};
  let generic = null;
  const protocol = {};
  for (const segment of proxyServer.split(";")) {
    const value = segment.trim();
    if (!value) continue;
    const separator = value.indexOf("=");
    if (separator < 0) {
      generic ||= value;
      continue;
    }
    const name = value.slice(0, separator).trim().toLowerCase();
    if (name === "http" || name === "https") protocol[name] = value.slice(separator + 1).trim();
  }
  const http = safeProxyEndpoint(protocol.http || generic);
  const https = safeProxyEndpoint(protocol.https || generic);
  return {
    ...(http ? { HTTP_PROXY: http } : {}),
    ...(https ? { HTTPS_PROXY: https } : {}),
  };
}

function registryValue(output, name, type) {
  const match = String(output || "").match(new RegExp(`(?:^|\\r?\\n)\\s*${name}\\s+${type}\\s+([^\\r\\n]+)`, "iu"));
  return match?.[1]?.trim() || null;
}

export async function readWindowsUserProxyEnvironment({
  env = process.env,
  platform = process.platform,
  execFile = nodeExecFile,
} = {}) {
  const inherited = buildSafeAgyEnvironment(env);
  const explicit = {
    ...(inherited.HTTP_PROXY ? { HTTP_PROXY: inherited.HTTP_PROXY } : {}),
    ...(inherited.HTTPS_PROXY ? { HTTPS_PROXY: inherited.HTTPS_PROXY } : {}),
  };
  if (platform !== "win32" || (explicit.HTTP_PROXY && explicit.HTTPS_PROXY)) return explicit;

  const systemRoot = inherited.SYSTEMROOT || inherited.WINDIR || "C:\\Windows";
  const registry = win32.join(systemRoot, "System32", "reg.exe");
  const options = {
    encoding: "utf8",
    env: inherited,
    windowsHide: true,
    timeout: RUNTIME_TIMEOUT_MS,
    maxBuffer: MAX_RUNTIME_OUTPUT_BYTES,
  };
  try {
    const enabledOutput = await invokeExecFile(execFile, registry, [
      "query", WINDOWS_INTERNET_SETTINGS_KEY, "/v", "ProxyEnable",
    ], options);
    const serverOutput = await invokeExecFile(execFile, registry, [
      "query", WINDOWS_INTERNET_SETTINGS_KEY, "/v", "ProxyServer",
    ], options);
    const enabledValue = registryValue(enabledOutput.stdout, "ProxyEnable", "REG_DWORD");
    const proxyServer = registryValue(serverOutput.stdout, "ProxyServer", "REG_(?:EXPAND_)?SZ");
    const discovered = parseWindowsProxyServer(proxyServer, { enabled: Number(enabledValue) === 1 });
    return { ...discovered, ...explicit };
  } catch {
    return explicit;
  }
}

async function hashFileSha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function defaultSignatureVerifier(agyPath) {
  if (process.platform !== "win32") return { trusted: false, signer: null };
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const environment = buildSafeAgyEnvironment(process.env);
  environment.AGY_RUNTIME_SIGNATURE_TARGET = agyPath;
  const command = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:AGY_RUNTIME_SIGNATURE_TARGET",
    "$subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }",
    "[pscustomobject]@{ Status = [string]$signature.Status; Signer = $subject } | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const { stdout } = await invokeExecFile(nodeExecFile, powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ], {
      encoding: "utf8",
      env: environment,
      windowsHide: true,
      timeout: RUNTIME_TIMEOUT_MS,
      maxBuffer: MAX_RUNTIME_OUTPUT_BYTES,
    });
    const parsed = JSON.parse(stdout || "{}");
    return { trusted: parsed?.Status === "Valid", signer: parsed?.Signer || null };
  } catch {
    return { trusted: false, signer: null };
  }
}

function normalizedSignature(value) {
  if (typeof value === "string") return { trusted: true, signer: value };
  if (!value || typeof value !== "object") return { trusted: false, signer: null };
  const signer = typeof value.signer === "string"
    ? value.signer
    : typeof value.subject === "string"
      ? value.subject
      : null;
  const status = String(value.status || value.signatureStatus || "");
  return {
    trusted: value.trusted === true || value.valid === true || /^(valid|trusted)$/i.test(status),
    signer,
  };
}

function failureReport(failureKind, observed = {}) {
  return {
    ok: false,
    status: "UNAVAILABLE",
    failureKind,
    expectedVersion: SUPPORTED_AGY_VERSION,
    expectedSha256: SUPPORTED_AGY_SHA256,
    observedVersion: observed.observedVersion || null,
    observedSha256: observed.observedSha256 || null,
    signatureStatus: observed.signatureStatus || "UNKNOWN",
    missingFlags: Array.isArray(observed.missingFlags) ? observed.missingFlags : [],
    version: null,
    sha256: null,
    signer: null,
    defaults: { model: DEFAULT_AGY_MODEL, effort: DEFAULT_AGY_EFFORT },
    capabilities: {
      streamJson: false,
      conversation: false,
      model: false,
      effort: false,
      sandbox: false,
    },
  };
}

function readyReport() {
  return {
    ok: true,
    status: "READY",
    failureKind: null,
    version: SUPPORTED_AGY_VERSION,
    sha256: SUPPORTED_AGY_SHA256,
    signer: "GOOGLE_LLC_VERIFIED",
    defaults: { model: DEFAULT_AGY_MODEL, effort: DEFAULT_AGY_EFFORT },
    capabilities: {
      streamJson: true,
      conversation: true,
      model: true,
      effort: true,
      sandbox: true,
    },
  };
}

function reportedVersion(stdout) {
  const match = String(stdout || "").match(/\b\d+\.\d+\.\d+\b/);
  return match ? match[0] : null;
}

export function createRuntimeVerifier({
  execFile = nodeExecFile,
  signatureVerifier = defaultSignatureVerifier,
  hashFile = hashFileSha256,
  stat = fs.stat,
  env = process.env,
  platform = process.platform,
} = {}) {
  const commandOptions = {
    encoding: "utf8",
    env: buildSafeAgyEnvironment(env),
    windowsHide: true,
    timeout: RUNTIME_TIMEOUT_MS,
    maxBuffer: MAX_RUNTIME_OUTPUT_BYTES,
  };

  return {
    async verify({ agyPath } = {}) {
      const executable = typeof agyPath === "string" && agyPath.trim()
        ? agyPath
        : defaultAgyPath({ env, platform });
      if (!executable) return failureReport("RUNTIME_MISSING");

      try {
        const file = await invokePathFunction(stat, executable);
        if (!file || typeof file.isFile !== "function" || !file.isFile()) {
          return failureReport("RUNTIME_MISSING");
        }
      } catch {
        return failureReport("RUNTIME_MISSING");
      }

      let actualHash;
      try {
        actualHash = String(await hashFile(executable)).toUpperCase();
      } catch {
        return failureReport("HASH_UNAVAILABLE");
      }
      if (actualHash !== SUPPORTED_AGY_SHA256) {
        return failureReport("HASH_MISMATCH", { observedSha256: actualHash });
      }

      if (platform === "win32") {
        let signature;
        try {
          signature = normalizedSignature(await signatureVerifier(executable));
        } catch {
          return failureReport("SIGNATURE_UNVERIFIED", { observedSha256: actualHash, signatureStatus: "UNVERIFIED" });
        }
        if (!signature.trusted || !signature.signer?.toLowerCase().includes(EXPECTED_AGY_SIGNER.toLowerCase())) {
          return failureReport("SIGNATURE_UNVERIFIED", { observedSha256: actualHash, signatureStatus: "UNVERIFIED" });
        }
      }

      let versionOutput;
      try {
        ({ stdout: versionOutput } = await invokeExecFile(execFile, executable, ["--version"], commandOptions));
      } catch (failure) {
        return failureReport(classifyAgyStderr(failure?.stderr));
      }
      if (!versionOutput) return failureReport("UNKNOWN_VERSION", { observedSha256: actualHash, signatureStatus: "GOOGLE_LLC_VERIFIED" });
      const observedVersion = reportedVersion(versionOutput);
      if (observedVersion !== SUPPORTED_AGY_VERSION) {
        return failureReport("UNSUPPORTED_VERSION", {
          observedVersion,
          observedSha256: actualHash,
          signatureStatus: "GOOGLE_LLC_VERIFIED",
        });
      }

      let helpOutput;
      try {
        const help = await invokeExecFile(execFile, executable, ["--help"], commandOptions);
        helpOutput = `${help.stdout || ""}\n${help.stderr || ""}`;
      } catch (failure) {
        return failureReport(classifyAgyStderr(failure?.stderr));
      }
      const missingFlags = REQUIRED_AGY_HELP_FLAGS.filter((flag) => !helpOutput?.includes(flag));
      if (missingFlags.length) {
        return failureReport("MISSING_REQUIRED_FLAGS", {
          observedVersion,
          observedSha256: actualHash,
          signatureStatus: "GOOGLE_LLC_VERIFIED",
          missingFlags,
        });
      }

      let finalHash;
      try {
        finalHash = String(await hashFile(executable)).toUpperCase();
      } catch {
        return failureReport("HASH_UNAVAILABLE");
      }
      if (finalHash !== actualHash) {
        return failureReport("RUNTIME_CHANGED_DURING_GATE", {
          observedVersion,
          observedSha256: finalHash,
          signatureStatus: "GOOGLE_LLC_VERIFIED",
        });
      }

      return readyReport();
    },
  };
}
