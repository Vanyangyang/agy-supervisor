#!/usr/bin/env node

// scripts/supervisor-daemon.mjs
import { createHash as createHash6, randomUUID as randomUUID4 } from "node:crypto";
import { readFile as readFile3, realpath, stat as stat2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import path3 from "node:path";
import { fileURLToPath } from "node:url";

// scripts/agy-runner.mjs
import { spawn as nodeSpawn } from "node:child_process";
import { realpath as nodeRealpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

// scripts/agy-runtime.mjs
import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { win32 } from "node:path";
var SUPPORTED_AGY_VERSION = "1.1.25";
var SUPPORTED_AGY_SHA256 = "DBC665F942B59E56A0D3317AA01B93ACC9521BDAA76277B922D82EF90EBA2B3C";
var EXPECTED_AGY_SIGNER = "Google LLC";
var DEFAULT_AGY_MODEL = "gemini-3.8-flash";
var DEFAULT_AGY_EFFORT = "high";
var SUPPORTED_AGY_EFFORTS = Object.freeze(["low", "medium", "high"]);
var REQUIRED_AGY_HELP_FLAGS = Object.freeze([
  "--input-format",
  "--output-format",
  "--conversation",
  "--model",
  "--effort",
  "--sandbox",
  "--dangerously-skip-permissions"
]);
var AGY_STDERR_KINDS = Object.freeze({
  AUTH_REQUIRED_IN_USER_TERMINAL: "AUTH_REQUIRED_IN_USER_TERMINAL",
  KEYRING_UNAVAILABLE: "KEYRING_UNAVAILABLE",
  RUNTIME_ERROR: "RUNTIME_ERROR"
});
var MAX_RUNTIME_OUTPUT_BYTES = 64 * 1024;
var RUNTIME_TIMEOUT_MS = 5e3;
var WINDOWS_INTERNET_SETTINGS_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`;
var SAFE_ENVIRONMENT_KEYS = Object.freeze([
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
  "no_proxy"
]);
var SECRET_NAME = /(?:api[_-]?key|token|secret|pass(?:word|phrase)?|credential|auth(?:entication|orization)?|private[_-]?key)/i;
function normalizedEnvironment(sourceEnv) {
  const values = /* @__PURE__ */ new Map();
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
function buildSafeAgyEnvironment(sourceEnv = process.env) {
  const source = normalizedEnvironment(sourceEnv);
  const safe = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const normalizedKey2 = key.toUpperCase();
    const value = source.get(normalizedKey2);
    if (typeof value === "string" && !SECRET_NAME.test(key)) {
      const accepted = safeEnvironmentValue(normalizedKey2, value);
      if (accepted !== null) safe[normalizedKey2] = accepted;
    }
  }
  safe.CI = "true";
  safe.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  return safe;
}
function defaultAgyPath({ env = process.env, platform = process.platform } = {}) {
  const localAppData = Object.entries(env || {}).find(([key, value]) => key.toUpperCase() === "LOCALAPPDATA" && typeof value === "string")?.[1];
  if (platform !== "win32" || typeof localAppData !== "string" || !localAppData.trim()) {
    return null;
  }
  return win32.join(localAppData, "agy", "bin", "agy.exe");
}
function classifyAgyStderr(stderr) {
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
function invokePathFunction(fn, path4) {
  return new Promise((resolve4, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve4(value);
    };
    try {
      const returned = fn(path4, done);
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
function invokeExecFile(execFile2, file, args, options) {
  return new Promise((resolve4, reject) => {
    let settled = false;
    const done = (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject({ stderr: boundedText(stderr ?? error.stderr), error });
      } else {
        resolve4({ stdout: boundedText(stdout), stderr: boundedText(stderr) });
      }
    };
    try {
      const returned = execFile2(file, args, options, done);
      if (returned && typeof returned.then === "function") {
        returned.then(
          (value) => done(null, value?.stdout ?? value, value?.stderr),
          (error) => done(error, error?.stdout, error?.stderr)
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
    if (!parsed.hostname || parsed.pathname && parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
function parseWindowsProxyServer(proxyServer, { enabled = true } = {}) {
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
    ...http ? { HTTP_PROXY: http } : {},
    ...https ? { HTTPS_PROXY: https } : {}
  };
}
function registryValue(output, name, type) {
  const match = String(output || "").match(new RegExp(`(?:^|\\r?\\n)\\s*${name}\\s+${type}\\s+([^\\r\\n]+)`, "iu"));
  return match?.[1]?.trim() || null;
}
async function readWindowsUserProxyEnvironment({
  env = process.env,
  platform = process.platform,
  execFile: execFile2 = nodeExecFile
} = {}) {
  const inherited = buildSafeAgyEnvironment(env);
  const explicit = {
    ...inherited.HTTP_PROXY ? { HTTP_PROXY: inherited.HTTP_PROXY } : {},
    ...inherited.HTTPS_PROXY ? { HTTPS_PROXY: inherited.HTTPS_PROXY } : {}
  };
  if (platform !== "win32" || explicit.HTTP_PROXY && explicit.HTTPS_PROXY) return explicit;
  const systemRoot = inherited.SYSTEMROOT || inherited.WINDIR || "C:\\Windows";
  const registry = win32.join(systemRoot, "System32", "reg.exe");
  const options = {
    encoding: "utf8",
    env: inherited,
    windowsHide: true,
    timeout: RUNTIME_TIMEOUT_MS,
    maxBuffer: MAX_RUNTIME_OUTPUT_BYTES
  };
  try {
    const enabledOutput = await invokeExecFile(execFile2, registry, [
      "query",
      WINDOWS_INTERNET_SETTINGS_KEY,
      "/v",
      "ProxyEnable"
    ], options);
    const serverOutput = await invokeExecFile(execFile2, registry, [
      "query",
      WINDOWS_INTERNET_SETTINGS_KEY,
      "/v",
      "ProxyServer"
    ], options);
    const enabledValue = registryValue(enabledOutput.stdout, "ProxyEnable", "REG_DWORD");
    const proxyServer = registryValue(serverOutput.stdout, "ProxyServer", "REG_(?:EXPAND_)?SZ");
    const discovered = parseWindowsProxyServer(proxyServer, { enabled: Number(enabledValue) === 1 });
    return { ...discovered, ...explicit };
  } catch {
    return explicit;
  }
}
async function hashFileSha256(path4) {
  return new Promise((resolve4, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path4);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve4(hash.digest("hex")));
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
    "[pscustomobject]@{ Status = [string]$signature.Status; Signer = $subject } | ConvertTo-Json -Compress"
  ].join("; ");
  try {
    const { stdout } = await invokeExecFile(nodeExecFile, powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command
    ], {
      encoding: "utf8",
      env: environment,
      windowsHide: true,
      timeout: RUNTIME_TIMEOUT_MS,
      maxBuffer: MAX_RUNTIME_OUTPUT_BYTES
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
  const signer = typeof value.signer === "string" ? value.signer : typeof value.subject === "string" ? value.subject : null;
  const status = String(value.status || value.signatureStatus || "");
  return {
    trusted: value.trusted === true || value.valid === true || /^(valid|trusted)$/i.test(status),
    signer
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
      sandbox: false
    }
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
      sandbox: true
    }
  };
}
function reportedVersion(stdout) {
  const match = String(stdout || "").match(/\b\d+\.\d+\.\d+\b/);
  return match ? match[0] : null;
}
function createRuntimeVerifier({
  execFile: execFile2 = nodeExecFile,
  signatureVerifier = defaultSignatureVerifier,
  hashFile = hashFileSha256,
  stat: stat3 = fs.stat,
  env = process.env,
  platform = process.platform
} = {}) {
  const commandOptions = {
    encoding: "utf8",
    env: buildSafeAgyEnvironment(env),
    windowsHide: true,
    timeout: RUNTIME_TIMEOUT_MS,
    maxBuffer: MAX_RUNTIME_OUTPUT_BYTES
  };
  return {
    async verify({ agyPath } = {}) {
      const executable = typeof agyPath === "string" && agyPath.trim() ? agyPath : defaultAgyPath({ env, platform });
      if (!executable) return failureReport("RUNTIME_MISSING");
      try {
        const file = await invokePathFunction(stat3, executable);
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
        ({ stdout: versionOutput } = await invokeExecFile(execFile2, executable, ["--version"], commandOptions));
      } catch (failure) {
        return failureReport(classifyAgyStderr(failure?.stderr));
      }
      if (!versionOutput) return failureReport("UNKNOWN_VERSION", { observedSha256: actualHash, signatureStatus: "GOOGLE_LLC_VERIFIED" });
      const observedVersion = reportedVersion(versionOutput);
      if (observedVersion !== SUPPORTED_AGY_VERSION) {
        return failureReport("UNSUPPORTED_VERSION", {
          observedVersion,
          observedSha256: actualHash,
          signatureStatus: "GOOGLE_LLC_VERIFIED"
        });
      }
      let helpOutput;
      try {
        const help = await invokeExecFile(execFile2, executable, ["--help"], commandOptions);
        helpOutput = `${help.stdout || ""}
${help.stderr || ""}`;
      } catch (failure) {
        return failureReport(classifyAgyStderr(failure?.stderr));
      }
      const missingFlags = REQUIRED_AGY_HELP_FLAGS.filter((flag) => !helpOutput?.includes(flag));
      if (missingFlags.length) {
        return failureReport("MISSING_REQUIRED_FLAGS", {
          observedVersion,
          observedSha256: actualHash,
          signatureStatus: "GOOGLE_LLC_VERIFIED",
          missingFlags
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
          signatureStatus: "GOOGLE_LLC_VERIFIED"
        });
      }
      return readyReport();
    }
  };
}

// scripts/agy-runner.mjs
var AGY_MODEL_ATTESTATION_TIMING = "INIT_BEFORE_PROMPT";
var AGY_EFFORT_STATUS = "ACCEPTED_NOT_ATTESTED";
var AGY_PERMISSION_MODE = "always-proceed";
var DEFAULT_INIT_TIMEOUT_MS = 3e4;
var DEFAULT_CLOSE_TIMEOUT_MS = 5e3;
var DEFAULT_CANCEL_TIMEOUT_MS = 5e3;
var DEFAULT_MAX_LINE_BYTES = 256 * 1024;
var DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
var DEFAULT_MAX_STDERR_BYTES = 8 * 1024;
var DEFAULT_MAX_RESPONSE_CHARS = 8e3;
var DEFAULT_MAX_PROMPT_BYTES = 64 * 1024;
var DEFAULT_MAX_EVENTS = 4096;
var OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var AgySessionError = class extends Error {
  constructor(code) {
    super(code);
    this.name = "AgySessionError";
    this.code = code;
  }
};
function asSessionError(error, fallback = "RUNTIME_ERROR") {
  return error instanceof AgySessionError ? error : new AgySessionError(fallback);
}
function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolvePromiseArgument, rejectPromiseArgument) => {
    resolvePromise = resolvePromiseArgument;
    rejectPromise = rejectPromiseArgument;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(Math.floor(number), maximum)) : fallback;
}
function exactOpaqueId(value) {
  return typeof value === "string" && OPAQUE_ID.test(value) ? value : null;
}
function exactModel(value) {
  return typeof value === "string" && MODEL_NAME.test(value) ? value : null;
}
function field(object, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(object, name)) return object[name];
  }
  return void 0;
}
function eventName(value) {
  const name = field(value, ["event", "type"]);
  return typeof name === "string" ? name : null;
}
function canonicalKey(value, platform) {
  const normalized = resolve(value).replace(/[\\/]+/g, platform === "win32" ? "\\" : "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
function boundedResponse(value, maximum) {
  const normalized = typeof value === "string" ? value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim() : "";
  return {
    text: normalized.length > maximum ? `${normalized.slice(0, maximum)}\u2026` : normalized,
    truncated: normalized.length > maximum
  };
}
function resultContent(value) {
  const result = value.result;
  return typeof result.response === "string" ? result.response : "";
}
function resultStatus(value) {
  return field(value.result, ["status"]);
}
function resultConversationId(value) {
  return field(value.result, ["conversation_id", "conversationId"]);
}
function toolFailure(value) {
  const info = value.tool_info && typeof value.tool_info === "object" ? value.tool_info : value;
  const status = String(info.status || info.state || "");
  const permission = `${info.permission || ""} ${info.permission_mode || ""} ${info.permissionMode || ""}`;
  return {
    hasError: Boolean(info.error || info.error_message || info.errorMessage) || /^(error|failed|failure)$/i.test(status),
    permissionDenied: info.permission_denied === true || info.permissionDenied === true || String(info.permission_denied || "").toLowerCase() === "true" || String(info.permissionDenied || "").toLowerCase() === "true" || /denied/i.test(permission)
  };
}
function waitFor(promise, timeoutMs) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      () => {
        clearTimeout(timer);
        resolvePromise(null);
      }
    );
  });
}
function initializationTimeoutError(stderr) {
  const classified = classifyAgyStderr(stderr);
  return new AgySessionError(classified === "RUNTIME_ERROR" ? "INIT_TIMEOUT" : classified);
}
async function writeLine(stream, line) {
  await new Promise((resolvePromise, rejectPromise) => {
    if (!stream || stream.destroyed || !stream.writable) {
      rejectPromise(new AgySessionError("STDIN_UNAVAILABLE"));
      return;
    }
    try {
      stream.write(line, "utf8", (error) => {
        if (error) rejectPromise(new AgySessionError("STDIN_UNAVAILABLE"));
        else resolvePromise();
      });
    } catch {
      rejectPromise(new AgySessionError("STDIN_UNAVAILABLE"));
    }
  });
}
var AgySessionProcess = class {
  constructor({
    agyPath = defaultAgyPath(),
    cwd,
    conversationId = null,
    model = DEFAULT_AGY_MODEL,
    effort = DEFAULT_AGY_EFFORT,
    env = process.env,
    spawnImpl = nodeSpawn,
    beforeSpawn = null,
    initTimeoutMs = DEFAULT_INIT_TIMEOUT_MS,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    cancelTimeoutMs = DEFAULT_CANCEL_TIMEOUT_MS,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
    maxResponseChars = DEFAULT_MAX_RESPONSE_CHARS,
    maxPromptBytes = DEFAULT_MAX_PROMPT_BYTES,
    maxEvents = DEFAULT_MAX_EVENTS,
    onActivity = () => {
    },
    realpathImpl = nodeRealpath,
    platform = process.platform
  } = {}) {
    this._agyPath = typeof agyPath === "string" && agyPath.trim() ? agyPath : null;
    this._cwd = typeof cwd === "string" && cwd.trim() && isAbsolute(cwd) ? cwd : null;
    this._requestedConversationId = conversationId === null ? null : exactOpaqueId(conversationId);
    this._conversationIdInvalid = conversationId !== null && this._requestedConversationId === null;
    this._model = exactModel(model);
    this._effort = SUPPORTED_AGY_EFFORTS.includes(effort) ? effort : null;
    this._env = buildSafeAgyEnvironment(env);
    this._spawnImpl = typeof spawnImpl === "function" ? spawnImpl : null;
    this._beforeSpawn = beforeSpawn === null || typeof beforeSpawn === "function" ? beforeSpawn : void 0;
    this._initTimeoutMs = boundedNumber(initTimeoutMs, DEFAULT_INIT_TIMEOUT_MS, 100, 3e4);
    this._closeTimeoutMs = boundedNumber(closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 100, 3e4);
    this._cancelTimeoutMs = boundedNumber(cancelTimeoutMs, DEFAULT_CANCEL_TIMEOUT_MS, 100, 3e4);
    this._maxLineBytes = boundedNumber(maxLineBytes, DEFAULT_MAX_LINE_BYTES, 128, 512 * 1024);
    this._maxOutputBytes = boundedNumber(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, this._maxLineBytes, 4 * 1024 * 1024);
    this._maxStderrBytes = boundedNumber(maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, 128, 64 * 1024);
    this._maxResponseChars = boundedNumber(maxResponseChars, DEFAULT_MAX_RESPONSE_CHARS, 1, 32e3);
    this._maxPromptBytes = boundedNumber(maxPromptBytes, DEFAULT_MAX_PROMPT_BYTES, 1, 1024 * 1024);
    this._maxEvents = boundedNumber(maxEvents, DEFAULT_MAX_EVENTS, 1, 8192);
    this._onActivity = typeof onActivity === "function" ? onActivity : () => {
    };
    this._realpath = typeof realpathImpl === "function" ? realpathImpl : null;
    this._platform = platform;
    this._state = "new";
    this._child = null;
    this._canonicalCwd = null;
    this._conversationId = null;
    this._init = null;
    this._runtimeReport = null;
    this._initDeferred = null;
    this._exitDeferred = null;
    this._exitInfo = null;
    this._exitFinalized = false;
    this._startPromise = null;
    this._initTimer = null;
    this._cancelTimer = null;
    this._turn = null;
    this._turnQueue = Promise.resolve();
    this._eventChain = Promise.resolve();
    this._fatalError = null;
    this._stdoutBuffer = Buffer.alloc(0);
    this._stdoutBytes = 0;
    this._stderrBytes = 0;
    this._stderr = "";
    this._eventCount = 0;
  }
  get pid() {
    return Number.isInteger(this._child?.pid) ? this._child.pid : null;
  }
  get conversationId() {
    return this._conversationId;
  }
  get init() {
    return this._init ? { ...this._init } : null;
  }
  get runtimeReport() {
    return this._runtimeReport ? structuredClone(this._runtimeReport) : null;
  }
  get runtimeState() {
    return this._state;
  }
  _activity(event) {
    try {
      this._onActivity({ ...event });
    } catch {
    }
  }
  async _canonicalize(path4) {
    if (typeof path4 !== "string" || !path4.trim() || !isAbsolute(path4) || !this._realpath) return null;
    try {
      return await this._realpath(path4);
    } catch {
      return null;
    }
  }
  _isAlive() {
    return Boolean(this._child && !this._exitInfo && this._child.exitCode === null && this._child.signalCode === null);
  }
  _args() {
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      this._model,
      "--effort",
      this._effort,
      "--sandbox",
      "--dangerously-skip-permissions"
    ];
    if (this._requestedConversationId) args.push("--conversation", this._requestedConversationId);
    return args;
  }
  _validateConfiguration() {
    if (!this._agyPath || !this._cwd || !this._model || !this._effort || !this._spawnImpl || !this._realpath || this._beforeSpawn === void 0) {
      throw new AgySessionError("INVALID_CONFIGURATION");
    }
    if (this._conversationIdInvalid) {
      throw new AgySessionError("INVALID_CONVERSATION_ID");
    }
  }
  _attachChild(child) {
    child.stdout.on("data", (chunk) => this._onStdout(chunk));
    child.stdout.on("end", () => this._finishStdout());
    child.stderr.on("data", (chunk) => this._onStderr(chunk));
    child.once("error", () => this._fail(new AgySessionError("PROCESS_ERROR")));
    child.once("exit", (code, signal) => {
      this._exitInfo = {
        code: Number.isInteger(code) ? code : null,
        signal: typeof signal === "string" ? signal : null
      };
      void this._eventChain.finally(() => this._finalizeExit());
    });
  }
  _onStderr(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    const combined = Buffer.concat([Buffer.from(this._stderr, "utf8"), Buffer.from(text, "utf8")]);
    const retained = combined.subarray(Math.max(0, combined.length - this._maxStderrBytes));
    this._stderr = retained.toString("utf8");
    this._stderrBytes = retained.length;
  }
  _resetOutputWindow() {
    this._stdoutBytes = 0;
    this._eventCount = 0;
  }
  _onStdout(chunk) {
    if (this._fatalError) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this._stdoutBytes += bytes.length;
    if (this._stdoutBytes > this._maxOutputBytes) {
      this._fail(new AgySessionError("OUTPUT_LIMIT"));
      return;
    }
    this._stdoutBuffer = Buffer.concat([this._stdoutBuffer, bytes]);
    while (!this._fatalError) {
      const newline = this._stdoutBuffer.indexOf(10);
      if (newline < 0) break;
      const line = this._stdoutBuffer.subarray(0, newline);
      this._stdoutBuffer = this._stdoutBuffer.subarray(newline + 1);
      this._acceptLine(line);
    }
    if (this._stdoutBuffer.length > this._maxLineBytes) this._fail(new AgySessionError("LINE_LIMIT"));
  }
  _finishStdout() {
    if (this._fatalError || this._stdoutBuffer.length === 0) return;
    const line = this._stdoutBuffer;
    this._stdoutBuffer = Buffer.alloc(0);
    this._acceptLine(line);
  }
  _acceptLine(line) {
    if (line.length > this._maxLineBytes) {
      this._fail(new AgySessionError("LINE_LIMIT"));
      return;
    }
    if (!line.length || line.every((byte) => byte === 13 || byte === 32 || byte === 9)) return;
    let value;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
      value = JSON.parse(text);
    } catch {
      this._fail(new AgySessionError("MALFORMED_NDJSON"));
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || ++this._eventCount > this._maxEvents) {
      this._fail(new AgySessionError("PROTOCOL_LIMIT"));
      return;
    }
    this._eventChain = this._eventChain.then(() => this._processEvent(value)).catch((error) => this._fail(asSessionError(error, "PROTOCOL_ERROR")));
  }
  async _processEvent(value) {
    if (this._fatalError) return;
    switch (eventName(value)) {
      case "init":
        await this._processInit(value);
        return;
      case "step_update":
        this._processStepUpdate(value);
        return;
      case "result":
        this._processResult(value);
        return;
      case "assistant":
      case "message":
        if (!this._turn) throw new AgySessionError("UNEXPECTED_EVENT");
        this._activity({ type: "assistant_activity" });
        return;
      case "error":
        throw new AgySessionError("RUNTIME_ERROR");
      case "permission":
        if (!this._turn) throw new AgySessionError("UNEXPECTED_EVENT");
        this._turn.permissionDenied = true;
        this._activity({ type: "permission_denied" });
        return;
      default:
        throw new AgySessionError("UNEXPECTED_EVENT");
    }
  }
  async _processInit(value) {
    if (this._state !== "starting" || this._init) throw new AgySessionError("UNEXPECTED_INIT");
    const init = value.init;
    if (!init || typeof init !== "object" || Array.isArray(init)) throw new AgySessionError("MALFORMED_INIT");
    const receivedCwd = field(init, ["cwd"]);
    const receivedModel = field(init, ["model"]);
    const permissionMode = field(init, ["permission_mode", "permissionMode"]);
    const receivedConversationId = exactOpaqueId(field(value, ["conversation_id", "conversationId"]));
    const canonicalReceivedCwd = await this._canonicalize(receivedCwd);
    if (!canonicalReceivedCwd || canonicalKey(canonicalReceivedCwd, this._platform) !== canonicalKey(this._canonicalCwd, this._platform)) {
      throw new AgySessionError("INIT_CWD_MISMATCH");
    }
    if (receivedModel !== this._model) throw new AgySessionError("INIT_MODEL_MISMATCH");
    if (permissionMode !== AGY_PERMISSION_MODE) throw new AgySessionError("INIT_PERMISSION_MISMATCH");
    if (!receivedConversationId || this._requestedConversationId && receivedConversationId !== this._requestedConversationId) {
      throw new AgySessionError("INIT_CONVERSATION_MISMATCH");
    }
    this._conversationId = receivedConversationId;
    this._init = {
      cwd: this._cwd,
      model: this._model,
      permissionMode: AGY_PERMISSION_MODE,
      conversationId: receivedConversationId,
      modelAttestationTiming: AGY_MODEL_ATTESTATION_TIMING,
      effortStatus: AGY_EFFORT_STATUS
    };
    clearTimeout(this._initTimer);
    this._initTimer = null;
    this._state = "ready";
    this._activity({
      type: "init",
      model: this._model,
      permissionMode: AGY_PERMISSION_MODE,
      conversationId: receivedConversationId,
      modelAttestationTiming: AGY_MODEL_ATTESTATION_TIMING,
      effortStatus: AGY_EFFORT_STATUS
    });
    this._initDeferred?.resolve(this.init);
  }
  _processStepUpdate(value) {
    const update = value.step_update;
    if (!update || typeof update !== "object" || Array.isArray(update) || !this._init || !this._turn) {
      throw new AgySessionError("UNEXPECTED_EVENT");
    }
    if (update.step_type !== "tool") {
      this._activity({ type: "step_update" });
      return;
    }
    const failure = toolFailure(update);
    this._turn.toolError ||= failure.hasError;
    this._turn.permissionDenied ||= failure.permissionDenied;
    this._activity({ type: "tool_step", hasError: failure.hasError, permissionDenied: failure.permissionDenied });
  }
  _rejectTurn(error, nextState = "ready") {
    clearTimeout(this._cancelTimer);
    this._cancelTimer = null;
    const turn = this._turn;
    this._turn = null;
    if (turn) turn.deferred.reject(asSessionError(error));
    if (!this._fatalError && !this._exitInfo) this._state = nextState;
  }
  _processResult(value) {
    const turn = this._turn;
    if (!turn) throw new AgySessionError("UNEXPECTED_RESULT");
    if (!value.result || typeof value.result !== "object" || Array.isArray(value.result)) {
      throw new AgySessionError("MALFORMED_RESULT");
    }
    if (resultConversationId(value) !== this._conversationId) {
      throw new AgySessionError("CONVERSATION_MISMATCH");
    }
    clearTimeout(this._cancelTimer);
    this._cancelTimer = null;
    if (turn.toolError || turn.permissionDenied) {
      this._rejectTurn(new AgySessionError("TOOL_FAILURE"));
      return;
    }
    if (resultStatus(value) !== "SUCCESS") {
      this._rejectTurn(new AgySessionError("TURN_NOT_SUCCESSFUL"));
      return;
    }
    const response = boundedResponse(resultContent(value), this._maxResponseChars);
    this._turn = null;
    this._state = "ready";
    turn.deferred.resolve({
      status: "SUCCESS",
      response: response.text,
      responseTruncated: response.truncated,
      metadata: {
        conversationId: this._conversationId,
        model: this._model,
        permissionMode: AGY_PERMISSION_MODE,
        effort: this._effort,
        effortStatus: AGY_EFFORT_STATUS,
        modelAttestationTiming: AGY_MODEL_ATTESTATION_TIMING,
        cancelRequested: turn.cancelRequested
      }
    });
    this._activity({ type: "turn_complete", status: "SUCCESS", conversationId: this._conversationId });
  }
  _finalizeExit() {
    if (this._exitFinalized) return;
    this._exitFinalized = true;
    clearTimeout(this._initTimer);
    this._initTimer = null;
    clearTimeout(this._cancelTimer);
    this._cancelTimer = null;
    this._exitDeferred?.resolve(this._exitInfo);
    this._activity({ type: "exit", exited: true });
    if (!this._init && !this._fatalError) {
      this._initDeferred?.reject(new AgySessionError(classifyAgyStderr(this._stderr)));
    }
    if (this._turn) {
      const error = this._turn.cancelRequested ? new AgySessionError("TURN_CANCELLED") : new AgySessionError(classifyAgyStderr(this._stderr));
      const turn = this._turn;
      this._turn = null;
      turn.deferred.reject(error);
    }
    if (!this._fatalError) this._state = "closed";
  }
  _fail(error) {
    const safeError = asSessionError(error);
    if (this._fatalError) return;
    this._fatalError = safeError;
    clearTimeout(this._initTimer);
    this._initTimer = null;
    clearTimeout(this._cancelTimer);
    this._cancelTimer = null;
    this._initDeferred?.reject(safeError);
    if (this._turn) {
      const turn = this._turn;
      this._turn = null;
      turn.deferred.reject(safeError);
    }
    this._state = "failed";
    this._activity({ type: "runtime_failed", code: safeError.code });
    const child = this._child;
    if (child && !this._exitInfo && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
      }
    }
  }
  async _start() {
    try {
      this._validateConfiguration();
      this._state = "starting";
      this._canonicalCwd = await this._canonicalize(this._cwd);
      if (!this._canonicalCwd) throw new AgySessionError("CWD_UNRESOLVED");
      this._initDeferred = deferred();
      this._exitDeferred = deferred();
      if (this._beforeSpawn) {
        const report = await this._beforeSpawn();
        if (!report?.ok) throw new AgySessionError(report?.failureKind || "RUNTIME_GATE_FAILED");
        this._runtimeReport = report;
      }
      const child = this._spawnImpl(this._agyPath, this._args(), {
        cwd: this._cwd,
        env: this._env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      if (!child?.stdin || !child?.stdout || !child?.stderr || typeof child.once !== "function") {
        throw new AgySessionError("SPAWN_FAILED");
      }
      this._child = child;
      this._attachChild(child);
      this._initTimer = setTimeout(() => this._fail(initializationTimeoutError(this._stderr)), this._initTimeoutMs);
      await this._initDeferred.promise;
      return this.init;
    } catch (error) {
      const safeError = asSessionError(error, "START_FAILED");
      this._fail(safeError);
      throw safeError;
    }
  }
  async start() {
    if (this._init && (this._state === "ready" || this._state === "turn_active")) return this.init;
    if (this._startPromise) return this._startPromise;
    if (this._state !== "new") throw new AgySessionError("START_UNAVAILABLE");
    this._startPromise = this._start();
    return this._startPromise;
  }
  async sendTurn(prompt) {
    if (typeof prompt !== "string" || !prompt.length || Buffer.byteLength(prompt, "utf8") > this._maxPromptBytes) {
      throw new AgySessionError("INVALID_PROMPT");
    }
    const run = async () => {
      await this.start();
      if (this._state !== "ready" || !this._isAlive()) throw new AgySessionError("PROCESS_UNAVAILABLE");
      this._resetOutputWindow();
      const turn = {
        deferred: deferred(),
        toolError: false,
        permissionDenied: false,
        cancelRequested: false
      };
      this._turn = turn;
      this._state = "turn_active";
      this._activity({ type: "turn_started", conversationId: this._conversationId });
      try {
        await writeLine(this._child.stdin, `${JSON.stringify({ event: "user", message: { content: prompt } })}
`);
      } catch (error) {
        this._rejectTurn(error);
        throw asSessionError(error);
      }
      const result = await turn.deferred.promise;
      return result;
    };
    const queued = this._turnQueue.catch(() => void 0).then(run);
    this._turnQueue = queued.catch(() => void 0);
    return queued;
  }
  async close() {
    const child = this._child;
    if (!child) {
      if (this._state === "new") this._state = "closed";
      return { status: this._state === "failed" ? "failed" : "closed", remoteStatus: "unknown" };
    }
    if (this._exitInfo) return { status: "closed", remoteStatus: "exited" };
    if (this._state !== "failed") this._state = "closing";
    try {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) child.stdin.end();
    } catch {
    }
    const exit = await waitFor(this._exitDeferred.promise, this._closeTimeoutMs);
    return exit ? { status: "closed", remoteStatus: "exited" } : { status: "close_pending", remoteStatus: "remote_unknown" };
  }
  async cancelCurrentTurn() {
    const child = this._child;
    if (!this._turn || !child || this._exitInfo) {
      return { status: "no_active_turn", remoteStatus: this._exitInfo ? "exited" : "remote_unknown" };
    }
    if (this._turn.cancelRequested) {
      return { status: "cancel_requested", remoteStatus: "remote_unknown", killAccepted: null, repeated: true };
    }
    this._turn.cancelRequested = true;
    this._state = "cancelling";
    let killAccepted = false;
    try {
      killAccepted = child.kill();
    } catch {
    }
    clearTimeout(this._cancelTimer);
    this._cancelTimer = setTimeout(() => {
      if (this._turn?.cancelRequested && !this._exitInfo) this._fail(new AgySessionError("CANCEL_TIMEOUT"));
    }, this._cancelTimeoutMs);
    this._activity({ type: "cancel_requested", conversationId: this._conversationId });
    return { status: "cancel_requested", remoteStatus: "remote_unknown", killAccepted };
  }
};

// scripts/process-identity.mjs
import { execFile as nodeExecFile2 } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import path from "node:path";
function execFile(file, args, options) {
  return new Promise((resolve4, reject) => {
    nodeExecFile2(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve4(stdout);
    });
  });
}
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function inspectProcessIdentity(pid, {
  platform = process.platform,
  execFileImpl = execFile,
  env = process.env
} = {}) {
  if (!processIsAlive(pid)) return { alive: false, fingerprint: null };
  if (platform !== "win32") return { alive: true, fingerprint: null };
  const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    `$item = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if ($null -eq $item) { exit 3 }",
    "$created = if ($item.CreationDate) { $item.CreationDate.ToUniversalTime().ToString('o') } else { $null }",
    "[pscustomobject]@{ Name = $item.Name; ExecutablePath = $item.ExecutablePath; CreatedAt = $created; CommandLine = $item.CommandLine } | ConvertTo-Json -Compress"
  ].join("; ");
  try {
    const output = await execFileImpl(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3e3,
      maxBuffer: 64 * 1024
    });
    const raw = JSON.parse(output);
    const identity = {
      name: typeof raw.Name === "string" ? raw.Name : null,
      executablePath: typeof raw.ExecutablePath === "string" ? raw.ExecutablePath : null,
      createdAt: typeof raw.CreatedAt === "string" ? raw.CreatedAt : null,
      commandLineSha256: createHash2("sha256").update(String(raw.CommandLine || ""), "utf8").digest("hex")
    };
    return {
      alive: true,
      executablePath: identity.executablePath,
      createdAt: identity.createdAt,
      fingerprint: createHash2("sha256").update(JSON.stringify(identity), "utf8").digest("hex")
    };
  } catch {
    return processIsAlive(pid) ? { alive: true, fingerprint: null } : { alive: false, fingerprint: null };
  }
}

// scripts/runtime-snapshot.mjs
import { createHash as createHash3, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import path2 from "node:path";
import { createReadStream as createReadStream2 } from "node:fs";
async function sha256(filePath) {
  return new Promise((resolve4, reject) => {
    const hash = createHash3("sha256");
    const stream = createReadStream2(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve4(hash.digest("hex").toUpperCase()));
  });
}
function unavailable(failureKind, observedSha256 = null) {
  return {
    ok: false,
    status: "UNAVAILABLE",
    failureKind,
    expectedVersion: SUPPORTED_AGY_VERSION,
    expectedSha256: SUPPORTED_AGY_SHA256,
    observedSha256
  };
}
async function prepareManagedRuntime({
  sourcePath,
  stateDir,
  verifier,
  hashFile = sha256,
  copyFileImpl = copyFile
}) {
  if (typeof sourcePath !== "string" || !path2.isAbsolute(sourcePath) || typeof stateDir !== "string" || !path2.isAbsolute(stateDir)) {
    return unavailable("RUNTIME_MISSING");
  }
  if (!verifier || typeof verifier.verify !== "function") return unavailable("RUNTIME_GATE_UNAVAILABLE");
  let sourceInfo;
  let sourceHash;
  try {
    sourceInfo = await stat(sourcePath);
    if (!sourceInfo.isFile()) return unavailable("RUNTIME_MISSING");
    sourceHash = await hashFile(sourcePath);
  } catch {
    return unavailable("RUNTIME_MISSING");
  }
  if (sourceHash !== SUPPORTED_AGY_SHA256) return unavailable("HASH_MISMATCH", sourceHash);
  const runtimeDir = path2.join(stateDir, "runtime");
  const snapshotPath = path2.join(runtimeDir, `agy-${SUPPORTED_AGY_VERSION}-${SUPPORTED_AGY_SHA256}.exe`);
  await mkdir(runtimeDir, { recursive: true, mode: 448 });
  let snapshotReady = false;
  try {
    snapshotReady = await hashFile(snapshotPath) === SUPPORTED_AGY_SHA256;
  } catch {
    snapshotReady = false;
  }
  if (!snapshotReady) {
    try {
      const existing = await stat(snapshotPath);
      if (existing.isFile()) return unavailable("RUNTIME_SNAPSHOT_TAMPERED", await hashFile(snapshotPath).catch(() => null));
    } catch (error) {
      if (error?.code !== "ENOENT") return unavailable("RUNTIME_SNAPSHOT_UNAVAILABLE");
    }
    const temporaryPath = path2.join(runtimeDir, `.agy-${randomUUID()}.tmp`);
    try {
      await copyFileImpl(sourcePath, temporaryPath);
      const copiedHash = await hashFile(temporaryPath);
      if (copiedHash !== SUPPORTED_AGY_SHA256) return unavailable("RUNTIME_CHANGED_DURING_COPY", copiedHash);
      await chmod(temporaryPath, 320).catch(() => {
      });
      try {
        await rename(temporaryPath, snapshotPath);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (await hashFile(snapshotPath) !== SUPPORTED_AGY_SHA256) return unavailable("RUNTIME_SNAPSHOT_TAMPERED");
      }
      snapshotReady = true;
    } catch {
      return unavailable("RUNTIME_SNAPSHOT_UNAVAILABLE");
    } finally {
      await unlink(temporaryPath).catch(() => {
      });
    }
  }
  const report = await verifier.verify({ agyPath: snapshotPath });
  if (!report?.ok) return report || unavailable("RUNTIME_GATE_FAILED");
  return {
    ...report,
    managedRuntime: true,
    managedRuntimePath: snapshotPath,
    executionPath: sourcePath,
    executionMode: "verified-installed-binary",
    sourceSha256: sourceHash
  };
}

// scripts/state-store.mjs
import { createHash as createHash4, randomUUID as randomUUID2 } from "node:crypto";
import { chmod as chmod2, mkdir as mkdir2, readFile, rename as rename2, unlink as unlink2, writeFile } from "node:fs/promises";
import { dirname, normalize, resolve as resolve2, win32 as win322 } from "node:path";
var STATE_SCHEMA_VERSION = 1;
var FORBIDDEN_KEY_PARTS = [
  "prompt",
  "response",
  "stdout",
  "stderr",
  "argv",
  "environment",
  "env",
  "token",
  "secret",
  "password",
  "credential",
  "oauth",
  "authcode"
];
var MAX_OBJECT_KEYS = 1e3;
var MAX_ARRAY_ITEMS = 1e3;
var MAX_KEY_LENGTH = 256;
var MAX_ID_LENGTH = 512;
var MAX_ENUM_LENGTH = 256;
var MAX_HASH_LENGTH = 256;
var MAX_TIMESTAMP_LENGTH = 128;
var MAX_PATH_LENGTH = 4096;
var WINDOWS_PATH_RE = /^(?:[a-z]:[\\/]|\\\\)/i;
function clone(value) {
  return structuredClone(value);
}
function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function normalizedKey(key) {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}
function isHashMetadataKey(key) {
  return key.includes("hash") || key.includes("sha") || key.includes("digest") || key.includes("fingerprint");
}
function isForbiddenKey(key) {
  const normalized = normalizedKey(key);
  return !isHashMetadataKey(normalized) && FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(part));
}
function stringLimitForKey(key) {
  const normalized = normalizedKey(key || "");
  if (!normalized) return 0;
  if (isHashMetadataKey(normalized) || normalized.includes("signature")) return MAX_HASH_LENGTH;
  if (/(?:id|ids)$/.test(normalized)) return MAX_ID_LENGTH;
  if (/(?:at|time|timestamp)$/.test(normalized)) return MAX_TIMESTAMP_LENGTH;
  if (/(?:cwd|path|workspace|directory|root)$/.test(normalized) || normalized.includes("workspace")) {
    return MAX_PATH_LENGTH;
  }
  if ([
    "model",
    "effort",
    "status",
    "phase",
    "state",
    "errorkind",
    "errorcode",
    "code",
    "version",
    "runtime",
    "runtimemode",
    "lifecycle",
    "lifecyclemode",
    "mode",
    "kind",
    "type",
    "reason",
    "owner",
    "source",
    "target",
    "policy",
    "transport"
  ].some((term) => normalized === term || normalized.endsWith(term))) {
    return MAX_ENUM_LENGTH;
  }
  return 0;
}
function validateValue(value, key, location, seen) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`State contains a non-finite number at ${location}`);
    return;
  }
  if (typeof value === "string") {
    const limit = stringLimitForKey(key);
    if (!limit) throw new TypeError(`State may only persist bounded metadata strings at ${location}`);
    if (value.length > limit) throw new RangeError(`State string exceeds its ${limit}-character limit at ${location}`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`State contains a non-JSON value at ${location}`);
  if (seen.has(value)) throw new TypeError(`State must not contain a cycle at ${location}`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new RangeError(`State array is too large at ${location}`);
    for (let index = 0; index < value.length; index += 1) {
      validateValue(value[index], key, `${location}[${index}]`, seen);
    }
    seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) throw new TypeError(`State contains a non-plain object at ${location}`);
  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_KEYS) throw new RangeError(`State object is too large at ${location}`);
  for (const [childKey, childValue] of entries) {
    if (childKey.length > MAX_KEY_LENGTH) throw new RangeError(`State key is too long at ${location}`);
    if (isForbiddenKey(childKey)) throw new TypeError(`State must not persist forbidden key: ${childKey}`);
    validateValue(childValue, childKey, `${location}.${childKey}`, seen);
  }
  seen.delete(value);
}
function createEmptyState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    sessions: {},
    runs: {},
    reservations: {}
  };
}
function validatePersistableState(state) {
  if (!isPlainObject(state)) throw new TypeError("State must be a plain object");
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported state schema version: ${String(state.schemaVersion)}`);
  }
  validateValue(state, "state", "state", /* @__PURE__ */ new WeakSet());
  return state;
}
function isTransientPointerKey(key) {
  const normalized = normalizedKey(key);
  return normalized === "pid" || normalized.endsWith("pid") || normalized === "processid" || normalized === "childprocess" || normalized === "process" || /^(?:active|current|pending|inflight)(?:turn|turnid|turnpointer|turnpointerid|run|runid|child|childpid|process|processid)$/.test(normalized);
}
function isReservationKey(key) {
  const normalized = normalizedKey(key);
  return normalized.endsWith("reservation") || normalized.endsWith("reservationid") || normalized.endsWith("reservationkey") || normalized === "reservations" || normalized === "workspacereservations" || normalized === "activereservation" || normalized === "activereservations";
}
function isInterruptedPhase(value) {
  return typeof value === "string" && ["starting", "running", "cancel_requested"].includes(value.toLowerCase());
}
function recoverInterruptedState(state, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!isPlainObject(state)) throw new TypeError("State must be a plain object");
  if (typeof nowIso !== "string" || nowIso.length > MAX_TIMESTAMP_LENGTH) {
    throw new TypeError("nowIso must be a bounded timestamp string");
  }
  const recovered = clone(state);
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isPlainObject(node)) return;
    let changedRunState = false;
    for (const key of Object.keys(node)) {
      if (isReservationKey(key)) {
        if (normalizedKey(key).endsWith("reservations")) node[key] = {};
        else delete node[key];
        continue;
      }
      if (isTransientPointerKey(key)) {
        if (Number.isInteger(node[key]) && node[key] > 0) node.recoveryProcessId = node[key];
        delete node[key];
        continue;
      }
      const normalized = normalizedKey(key);
      if ((normalized === "phase" || normalized === "status") && isInterruptedPhase(node[key])) {
        node[key] = "unknown_after_restart";
        changedRunState = true;
        continue;
      }
      visit(node[key]);
    }
    if (changedRunState) node.recoveredAt = nowIso;
  };
  visit(recovered);
  return recovered;
}
function canonicalWorkspace(pathValue) {
  if (typeof pathValue !== "string" || !pathValue.trim()) {
    throw new TypeError("Workspace path must be a non-empty string");
  }
  const input = pathValue.trim();
  const useWindowsPath = WINDOWS_PATH_RE.test(input);
  const canonical = useWindowsPath ? win322.normalize(win322.resolve(input)) : normalize(resolve2(input));
  return useWindowsPath || process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
function hashPrompt(prompt) {
  if (typeof prompt !== "string") throw new TypeError("Prompt must be a string");
  return {
    sha256: createHash4("sha256").update(prompt, "utf8").digest("hex"),
    bytes: Buffer.byteLength(prompt, "utf8")
  };
}
async function writeStateAtomically(filePath, state) {
  const directory = dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID2()}.tmp`;
  await mkdir2(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}
`, { encoding: "utf8", mode: 384, flag: "wx" });
    try {
      await chmod2(temporaryPath, 384);
    } catch {
    }
    await rename2(temporaryPath, filePath);
    try {
      await chmod2(filePath, 384);
    } catch {
    }
  } catch (error) {
    await unlink2(temporaryPath).catch(() => {
    });
    throw error;
  }
}
var StateStore = class {
  constructor(filePath, { now = () => (/* @__PURE__ */ new Date()).toISOString() } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new TypeError("StateStore requires a file path");
    if (typeof now !== "function") throw new TypeError("StateStore now must be a function");
    this.filePath = resolve2(filePath);
    this.now = now;
    this.state = null;
    this.loaded = false;
    this.loadPromise = null;
    this.queue = Promise.resolve();
  }
  enqueue(operation) {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => {
    });
    return pending;
  }
  async load() {
    if (!this.loadPromise) {
      this.loadPromise = this.enqueue(async () => {
        if (this.loaded) return;
        let parsed;
        try {
          parsed = JSON.parse(await readFile(this.filePath, "utf8"));
        } catch (error) {
          if (error?.code === "ENOENT") {
            this.state = createEmptyState();
            this.loaded = true;
            return;
          }
          if (error instanceof SyntaxError) {
            throw new Error(`State file is corrupt: ${this.filePath}`, { cause: error });
          }
          throw error;
        }
        validatePersistableState(parsed);
        const recovered = recoverInterruptedState(parsed, this.now());
        validatePersistableState(recovered);
        if (JSON.stringify(recovered) !== JSON.stringify(parsed)) {
          await writeStateAtomically(this.filePath, recovered);
        }
        this.state = recovered;
        this.loaded = true;
      });
    }
    await this.loadPromise;
    return clone(this.state);
  }
  async snapshot() {
    await this.load();
    await this.queue;
    return clone(this.state);
  }
  async update(mutator) {
    if (typeof mutator !== "function") throw new TypeError("StateStore update requires a mutator function");
    await this.load();
    return this.enqueue(async () => {
      const draft = clone(this.state);
      const result = await mutator(draft);
      const candidate = result === void 0 ? draft : result;
      validatePersistableState(candidate);
      await writeStateAtomically(this.filePath, candidate);
      this.state = clone(candidate);
      return clone(this.state);
    });
  }
};

// scripts/supervisor-transport.mjs
import { randomBytes, randomUUID as randomUUID3, timingSafeEqual, createHash as createHash5, createHmac } from "node:crypto";
import { mkdir as mkdir3, open, readFile as readFile2, chmod as chmod3, unlink as unlink3, writeFile as writeFile2 } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, resolve as resolve3 } from "node:path";
import net from "node:net";
var MAX_MESSAGE_BYTES = 64 * 1024;
var SUPERVISOR_PROTOCOL_VERSION = 1;
var SUPERVISOR_RUNTIME_VERSION = "0.3.0";
function getSupervisorPaths({ localAppData, stateDir: requestedStateDir, userName, homeDir } = {}) {
  const user = String(userName || process.env.USERNAME || userInfo().username);
  const stateDir = resolve3(requestedStateDir || (localAppData ? join(localAppData, "agy-supervisor") : join(homeDir || homedir(), ".agy-supervisor")));
  const identity = createHash5("sha256").update(`${stateDir.toLowerCase()}\0${user.toLowerCase()}`).digest("hex").slice(0, 32);
  const socketBasePath = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\agy-supervisor-${identity}` : join(stateDir, `supervisor-${identity}.sock`);
  return {
    stateDir,
    socketBasePath,
    socketPath: socketBasePath,
    tokenPath: join(stateDir, "supervisor.token"),
    epochPath: join(stateDir, "supervisor.epoch"),
    bootstrapEnvPath: join(stateDir, "bootstrap-env.json"),
    launchLockPath: join(stateDir, "supervisor.launch.lock")
  };
}
function resolveSupervisorPaths(paths, token) {
  const base = paths.socketBasePath || paths.socketPath;
  const suffix = createHmac("sha256", Buffer.from(token, "hex")).update(String(base).toLowerCase(), "utf8").digest("hex").slice(0, 24);
  const socketPath = process.platform === "win32" ? `${base}-${suffix}` : join(paths.stateDir, `supervisor-${suffix}.sock`);
  return { ...paths, socketBasePath: base, socketPath };
}
function validToken(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
async function ensureSupervisorToken(paths) {
  await mkdir3(paths.stateDir, { recursive: true, mode: 448 });
  await chmod3(paths.stateDir, 448).catch(() => {
  });
  try {
    const existing = (await readFile2(paths.tokenPath, "utf8")).trim();
    if (!validToken(existing)) throw new Error("invalid-token-file");
    await chmod3(paths.tokenPath, 384).catch(() => {
    });
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const created = randomBytes(32).toString("hex");
  try {
    const handle = await open(paths.tokenPath, "wx", 384);
    try {
      await handle.writeFile(`${created}
`, "utf8");
    } finally {
      await handle.close();
    }
    return created;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const winner = (await readFile2(paths.tokenPath, "utf8")).trim();
    if (!validToken(winner)) throw new Error("invalid-token-file");
    return winner;
  }
}
function signEnvelope(token, payload) {
  return createHmac("sha256", Buffer.from(token, "hex")).update(JSON.stringify(payload), "utf8").digest("hex");
}
function withMac(token, payload) {
  return { ...payload, mac: signEnvelope(token, payload) };
}
function macMatches(token, message) {
  const presented = typeof message?.mac === "string" && /^[0-9a-f]{64}$/u.test(message.mac) ? Buffer.from(message.mac, "hex") : Buffer.alloc(32);
  const unsigned = message && typeof message === "object" && !Array.isArray(message) ? { ...message } : {};
  delete unsigned.mac;
  let expected;
  try {
    expected = Buffer.from(signEnvelope(token, unsigned), "hex");
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
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(value) ? value : "handler_failed";
}
function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
function validMethod(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
async function socketIsLive(socketPath) {
  return new Promise((resolveLive) => {
    const socket = net.createConnection(socketPath);
    const done = (live) => {
      socket.destroy();
      resolveLive(live);
    };
    socket.setTimeout(150, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
async function listenLocal(server, paths) {
  const listen = () => new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(paths.socketPath);
  });
  try {
    await listen();
  } catch (error) {
    if (process.platform === "win32" || error?.code !== "EADDRINUSE" || await socketIsLive(paths.socketPath)) throw error;
    await unlink3(paths.socketPath).catch((unlinkError) => {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    });
    await listen();
  }
}
async function createSupervisorServer({ paths, token, epoch, handleRequest, pingResult = () => ({ ready: true }) }) {
  if (!paths?.stateDir || !paths?.socketPath || !paths?.epochPath) throw new TypeError("invalid-paths");
  if (!validToken(token)) throw new TypeError("invalid-token");
  const generation = String(epoch || "");
  if (!generation || generation.length > 128) throw new TypeError("invalid-epoch");
  if (typeof handleRequest !== "function") throw new TypeError("invalid-handler");
  const resolvedPaths = resolveSupervisorPaths(paths, token);
  await mkdir3(resolvedPaths.stateDir, { recursive: true, mode: 448 });
  await chmod3(resolvedPaths.stateDir, 448).catch(() => {
  });
  const sockets = /* @__PURE__ */ new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let writeTail = Promise.resolve();
    let closedForSize = false;
    const send = (message, end = false) => {
      let encoded;
      try {
        encoded = `${JSON.stringify(withMac(token, message))}
`;
      } catch {
        encoded = `${JSON.stringify(withMac(token, responseError("handler_failed", generation, message?.id ?? null)))}
`;
      }
      if (Buffer.byteLength(encoded, "utf8") - 1 > MAX_MESSAGE_BYTES) {
        encoded = `${JSON.stringify(withMac(token, responseError("oversized", generation, message?.id ?? null)))}
`;
      }
      writeTail = writeTail.then(() => new Promise((resolveWrite) => {
        if (socket.destroyed) return resolveWrite();
        socket.write(encoded, () => {
          if (end) socket.end();
          resolveWrite();
        });
      })).catch(() => {
      });
      return writeTail;
    };
    const processLine = async (line) => {
      let message;
      try {
        message = JSON.parse(line.toString("utf8"));
      } catch {
        macMatches(token, null);
        await send(responseError("malformed", generation));
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        macMatches(token, null);
        await send(responseError("malformed", generation));
        return;
      }
      const id = validId(message.id) ? message.id : null;
      if (!macMatches(token, message)) {
        await send(responseError("unauthorized", generation, id));
        return;
      }
      if (!validId(message.id) || typeof message.epoch !== "string" || !validMethod(message.method)) {
        await send(responseError("malformed", generation, id));
        return;
      }
      if (message.epoch !== generation) {
        await send(responseError("stale_epoch", generation, message.id));
        return;
      }
      if (message.method === "ping") {
        const custom = await pingResult();
        await send({
          id: message.id,
          epoch: generation,
          ok: true,
          result: {
            ...custom && typeof custom === "object" ? custom : {},
            protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
            runtimeVersion: SUPERVISOR_RUNTIME_VERSION
          }
        });
        return;
      }
      try {
        const result = await handleRequest({
          id: message.id,
          epoch: message.epoch,
          method: message.method,
          params: message.params
        });
        await send({ id: message.id, epoch: generation, ok: true, result: result ?? null });
      } catch (error) {
        await send(responseError(handlerErrorKind(error), generation, message.id));
      }
    };
    socket.on("data", (chunk) => {
      if (closedForSize) return;
      buffer = Buffer.concat([buffer, chunk]);
      for (; ; ) {
        const newline = buffer.indexOf(10);
        if (newline < 0) {
          if (buffer.length > MAX_MESSAGE_BYTES) {
            closedForSize = true;
            macMatches(token, null);
            void send(responseError("oversized", generation), true);
          }
          return;
        }
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length > MAX_MESSAGE_BYTES) {
          closedForSize = true;
          macMatches(token, null);
          void send(responseError("oversized", generation), true);
          return;
        }
        if (line.length === 0) continue;
        void processLine(line);
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
    });
  });
  await listenLocal(server, resolvedPaths);
  server.on("error", () => {
  });
  await writeFile2(resolvedPaths.epochPath, `${generation}
`, { encoding: "utf8", mode: 384 });
  let closing;
  const close = () => {
    if (closing) return closing;
    closing = new Promise((resolveClose) => {
      for (const socket of sockets) socket.destroy();
      server.close(async () => {
        if (process.platform !== "win32") await unlink3(resolvedPaths.socketPath).catch(() => {
        });
        resolveClose();
      });
    });
    return closing;
  };
  return { server, paths: resolvedPaths, epoch: generation, close };
}

// scripts/supervisor-daemon.mjs
var MAX_PROMPT_BYTES = 48e3;
var MAX_MEMORY_RESULTS = 100;
var MAX_DURABLE_RUNS = 500;
var MAX_DURABLE_SESSIONS = 200;
var MAX_IDEMPOTENCY_TOMBSTONES = 500;
var TERMINAL_RUN_STATUSES = /* @__PURE__ */ new Set([
  "completed",
  "failed",
  "cancelled_before_send",
  "acknowledged_uncertain"
]);
var SupervisorFault = class extends Error {
  constructor(kind) {
    super(kind);
    this.name = "SupervisorFault";
    this.kind = kind;
    this.code = kind;
  }
};
function fail(kind) {
  throw new SupervisorFault(kind);
}
function fixedKind(error, fallback = "TURN_FAILED") {
  const value = error?.kind || error?.code;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,95}$/u.test(value) ? value : fallback;
}
function workspaceDigest(cwd) {
  return createHash6("sha256").update(canonicalWorkspace(cwd), "utf8").digest("hex");
}
function resultDigest(text) {
  return createHash6("sha256").update(text, "utf8").digest("hex");
}
function operationDigest(value) {
  return createHash6("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function compactDurableHistory(state) {
  state.requestTombstones ||= {};
  const removableRuns = Object.values(state.runs).filter((run) => TERMINAL_RUN_STATUSES.has(run.status) || run.status === "failed").sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
  while (Object.keys(state.runs).length > MAX_DURABLE_RUNS && removableRuns.length) {
    const run = removableRuns.shift();
    if (run.requestId && run.intentSha256) {
      state.requestTombstones[operationDigest(run.requestId)] = {
        requestId: run.requestId,
        intentSha256: run.intentSha256,
        runId: run.runId,
        sessionId: run.sessionId,
        status: run.status,
        updatedAt: run.updatedAt
      };
    }
    delete state.runs[run.runId];
  }
  const tombstones = Object.entries(state.requestTombstones).sort(([, left], [, right]) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
  while (tombstones.length > MAX_IDEMPOTENCY_TOMBSTONES) {
    const [key] = tombstones.shift();
    delete state.requestTombstones[key];
  }
  const referencedSessions = new Set(Object.values(state.runs).map((run) => run.sessionId));
  const removableSessions = Object.values(state.sessions).filter((session) => session.status === "closed" && !referencedSessions.has(session.sessionId)).sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
  while (Object.keys(state.sessions).length > MAX_DURABLE_SESSIONS && removableSessions.length) {
    delete state.sessions[removableSessions.shift().sessionId];
  }
}
function validIdentifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
function publicSession(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    model: session.model,
    effort: session.effort,
    effortStatus: session.effortStatus,
    permissionMode: session.permissionMode,
    conversationId: session.conversationId || null,
    status: session.status,
    activeRunId: session.activeRunId || null,
    runtimeVersion: session.runtimeVersion || null,
    runtimeSha256: session.runtimeSha256 || null,
    runtimeSignatureStatus: session.runtimeSignatureStatus || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    closedAt: session.closedAt || null,
    recoveredAt: session.recoveredAt || null
  };
}
function publicRun(run, memoryResult) {
  if (!run) return null;
  const value = {
    runId: run.runId,
    sessionId: run.sessionId,
    requestId: run.requestId,
    status: run.status,
    phase: run.phase,
    resultStatus: run.resultStatus || null,
    errorKind: run.errorKind || null,
    failureKind: run.failureKind || null,
    remoteStatus: run.remoteStatus || null,
    requestSha256: run.requestSha256,
    requestBytes: run.requestBytes,
    resultSha256: run.resultSha256 || null,
    resultBytes: run.resultBytes ?? null,
    resultTruncated: run.resultTruncated ?? null,
    permissionDeniedSeen: Boolean(run.permissionDeniedSeen),
    toolFailureSeen: Boolean(run.toolFailureSeen),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt || null,
    cancelRequestedAt: run.cancelRequestedAt || null,
    recoveredAt: run.recoveredAt || null,
    resultAvailable: memoryResult !== void 0
  };
  if (memoryResult !== void 0) value.result = memoryResult;
  return value;
}
var AgySupervisorController = class {
  constructor({
    paths = getSupervisorPaths(),
    statePath = path3.join(paths.stateDir, "state.json"),
    verifier = createRuntimeVerifier(),
    SessionProcess = AgySessionProcess,
    agyPath = defaultAgyPath(),
    processProbe = inspectProcessIdentity,
    runtimePreparer = prepareManagedRuntime,
    agyEnvironment = process.env,
    environmentLoader = null,
    now = () => (/* @__PURE__ */ new Date()).toISOString(),
    uuid = randomUUID4
  } = {}) {
    this.paths = paths;
    this.store = new StateStore(statePath, { now });
    this.verifier = verifier;
    this.SessionProcess = SessionProcess;
    this.agyPath = agyPath;
    this.processProbe = processProbe;
    this.runtimePreparer = runtimePreparer;
    this.agyEnvironment = agyEnvironment;
    this.environmentLoader = typeof environmentLoader === "function" ? environmentLoader : null;
    this.now = now;
    this.uuid = uuid;
    this.epoch = null;
    this.processes = /* @__PURE__ */ new Map();
    this.memoryResults = /* @__PURE__ */ new Map();
    this.activity = /* @__PURE__ */ new Map();
    this.activeRunBySession = /* @__PURE__ */ new Map();
    this.waiters = /* @__PURE__ */ new Set();
    this.controlTail = Promise.resolve();
  }
  async initialize(epoch) {
    this.epoch = epoch;
    await this.store.load();
    await this._update((state) => {
      state.epochId = epoch;
      for (const session of Object.values(state.sessions)) delete session.pendingConversationId;
      for (const run of Object.values(state.runs)) {
        if (run.status === "unknown_after_restart" && (run.recoveryProcessId || run.remoteStatus !== "not_started" && run.remoteStatus !== "not_sent")) {
          state.reservations[run.workspaceHash] = { runId: run.runId, sessionId: run.sessionId };
        } else if (run.status === "unknown_after_restart" && !run.recoveryProcessId) {
          run.status = "cancelled_before_send";
          run.phase = "terminal";
          run.remoteStatus = "not_sent";
          run.resultStatus = "CANCELLED_BEFORE_SEND";
          run.completedAt = this.now();
          const session = state.sessions[run.sessionId];
          if (session) session.status = "idle";
        }
      }
    });
    return this;
  }
  _serialize(operation) {
    const pending = this.controlTail.then(operation, operation);
    this.controlTail = pending.catch(() => {
    });
    return pending;
  }
  async _update(mutator) {
    const next = await this.store.update((state) => {
      mutator(state);
      compactDurableHistory(state);
      state.revision = Number.isInteger(state.revision) ? state.revision + 1 : 1;
      state.updatedAt = this.now();
      return state;
    });
    this._notify(next.revision);
    return next;
  }
  _notify(revision) {
    for (const waiter of this.waiters) waiter(revision);
    this.waiters.clear();
  }
  async _waitForRevision(afterRevision, waitMs) {
    const first = await this.store.snapshot();
    if (!Number.isInteger(afterRevision) || first.revision > afterRevision || waitMs <= 0) return first;
    let settle;
    const changed = new Promise((resolveWait) => {
      settle = resolveWait;
    });
    const onRevision = (revision) => {
      if (revision > afterRevision) settle();
    };
    this.waiters.add(onRevision);
    const second = await this.store.snapshot();
    if (second.revision > afterRevision) settle();
    const timer = setTimeout(settle, Math.min(25e3, Math.max(0, waitMs)));
    await changed;
    clearTimeout(timer);
    this.waiters.delete(onRevision);
    return this.store.snapshot();
  }
  async _resolveWorkspace(value) {
    if (typeof value !== "string" || !value.trim() || !path3.isAbsolute(value)) fail("INVALID_WORKSPACE");
    let cwd;
    let info;
    try {
      cwd = await realpath(value);
      info = await stat2(cwd);
    } catch {
      fail("WORKSPACE_UNAVAILABLE");
    }
    if (!info.isDirectory()) fail("WORKSPACE_NOT_DIRECTORY");
    return { cwd, workspaceHash: workspaceDigest(cwd) };
  }
  _rememberResult(runId, response) {
    this.memoryResults.set(runId, response);
    while (this.memoryResults.size > MAX_MEMORY_RESULTS) {
      this.memoryResults.delete(this.memoryResults.keys().next().value);
    }
  }
  _hasUnacknowledgedRun(state, sessionId) {
    return Object.values(state.runs).some((run) => run.sessionId === sessionId && (run.status === "unknown_after_restart" || run.status === "needs_attention" || run.remoteStatus === "remote_unknown"));
  }
  async startTurn(params = {}) {
    if (params.confirmation !== "SEND_TO_AGY") fail("CONFIRMATION_REQUIRED");
    if (params.mode !== "new" && params.mode !== "resume") fail("INVALID_MODE");
    if (typeof params.prompt !== "string" || !params.prompt.length) fail("INVALID_PROMPT");
    const request = hashPrompt(params.prompt);
    if (request.bytes > MAX_PROMPT_BYTES) fail("PROMPT_TOO_LARGE");
    const workspace = await this._resolveWorkspace(params.cwd);
    if (params.requestId !== void 0 && !validIdentifier(params.requestId)) fail("INVALID_REQUEST_ID");
    const requestId = params.requestId || this.uuid();
    return this._serialize(async () => {
      const current = await this.store.snapshot();
      let sessionId = params.mode === "resume" ? params.sessionId : null;
      let selectedModel;
      let selectedEffort;
      if (params.mode === "new") {
        if (params.sessionId !== void 0) fail("NEW_SESSION_ID_NOT_ALLOWED");
        selectedModel = params.model || DEFAULT_AGY_MODEL;
        selectedEffort = params.effort || DEFAULT_AGY_EFFORT;
      } else {
        if (!validIdentifier(params.sessionId)) fail("SESSION_ID_REQUIRED");
        sessionId = params.sessionId;
        const session = current.sessions[sessionId];
        if (!session) fail("SESSION_NOT_FOUND");
        if (session.status === "closed") fail("SESSION_CLOSED");
        if (session.cwd !== workspace.cwd || session.workspaceHash !== workspace.workspaceHash) fail("SESSION_WORKSPACE_MISMATCH");
        if (!session.conversationId) fail("SESSION_NOT_RESUMABLE");
        if (params.model && params.model !== session.model) fail("SESSION_MODEL_FROZEN");
        if (params.effort && params.effort !== session.effort) fail("SESSION_EFFORT_FROZEN");
        selectedModel = session.model;
        selectedEffort = session.effort;
      }
      if (typeof selectedModel !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(selectedModel)) {
        fail("INVALID_MODEL");
      }
      if (!["low", "medium", "high"].includes(selectedEffort)) fail("INVALID_EFFORT");
      const intentSha256 = operationDigest({
        mode: params.mode,
        sessionId,
        workspaceHash: workspace.workspaceHash,
        requestSha256: request.sha256,
        requestBytes: request.bytes,
        model: selectedModel,
        effort: selectedEffort
      });
      const prior = Object.values(current.runs).find((run) => run.requestId === requestId);
      if (prior) {
        if (prior.intentSha256 !== intentSha256) fail("REQUEST_ID_CONFLICT");
        return {
          accepted: true,
          reused: true,
          revision: current.revision || 0,
          session: publicSession(current.sessions[prior.sessionId]),
          run: publicRun(prior, this.memoryResults.get(prior.runId))
        };
      }
      const tombstone = current.requestTombstones?.[operationDigest(requestId)];
      if (tombstone) {
        if (tombstone.intentSha256 !== intentSha256) fail("REQUEST_ID_CONFLICT");
        return {
          accepted: false,
          reused: true,
          archived: true,
          revision: current.revision || 0,
          requestId,
          sessionId: tombstone.sessionId,
          runId: tombstone.runId,
          status: tombstone.status
        };
      }
      if (params.mode === "resume") {
        const session = current.sessions[sessionId];
        if (session.activeRunId) fail("SESSION_BUSY");
        if (session.status === "unknown_after_restart" || this._hasUnacknowledgedRun(current, sessionId)) {
          fail("UNCERTAIN_RUN_ACK_REQUIRED");
        }
      } else {
        const openSessions = Object.values(current.sessions).filter((session) => session.status !== "closed").length;
        if (openSessions >= MAX_DURABLE_SESSIONS) fail("SESSION_LIMIT_REACHED");
        sessionId = `agy-${this.uuid()}`;
      }
      if (current.reservations[workspace.workspaceHash]) fail("WORKSPACE_BUSY");
      const runId = `run-${this.uuid()}`;
      const startedAt = this.now();
      const next = await this._update((state) => {
        const existing = state.sessions[sessionId];
        if (params.mode === "new") {
          state.sessions[sessionId] = {
            sessionId,
            cwd: workspace.cwd,
            workspaceHash: workspace.workspaceHash,
            model: selectedModel,
            effort: selectedEffort,
            effortStatus: "ACCEPTED_NOT_ATTESTED",
            permissionMode: null,
            conversationId: null,
            status: "starting",
            activeRunId: runId,
            createdAt: startedAt,
            updatedAt: startedAt
          };
        } else {
          if (!existing || existing.activeRunId) fail("SESSION_BUSY");
          existing.status = "starting";
          existing.activeRunId = runId;
          existing.updatedAt = startedAt;
        }
        state.runs[runId] = {
          runId,
          sessionId,
          requestId,
          intentSha256,
          workspaceHash: workspace.workspaceHash,
          requestSha256: request.sha256,
          requestBytes: request.bytes,
          status: "starting",
          phase: "runtime_gate",
          resultStatus: null,
          errorKind: null,
          remoteStatus: "not_started",
          permissionDeniedSeen: false,
          toolFailureSeen: false,
          startedAt,
          updatedAt: startedAt
        };
        state.reservations[workspace.workspaceHash] = { runId, sessionId };
      });
      this.activity.set(runId, { permissionDeniedSeen: false, toolFailureSeen: false });
      this.activeRunBySession.set(sessionId, runId);
      queueMicrotask(() => {
        void this._executeTurn(sessionId, runId, params.prompt);
      });
      return {
        accepted: true,
        reused: false,
        revision: next.revision,
        session: publicSession(next.sessions[sessionId]),
        run: publicRun(next.runs[runId])
      };
    });
  }
  async _runWasCancelled(runId) {
    const state = await this.store.snapshot();
    return state.runs[runId]?.status === "cancel_requested";
  }
  async _phase(sessionId, runId, phase, status = "running", extra = {}) {
    return this._update((state) => {
      const session = state.sessions[sessionId];
      const run = state.runs[runId];
      if (!session || !run || session.activeRunId !== runId) return;
      run.phase = phase;
      run.status = status;
      run.updatedAt = this.now();
      Object.assign(run, extra);
      session.status = status;
      session.updatedAt = this.now();
    });
  }
  async _cancelBeforeSend(sessionId, runId) {
    await this._update((state) => {
      const session = state.sessions[sessionId];
      const run = state.runs[runId];
      if (!session || !run) return;
      run.status = "cancelled_before_send";
      run.phase = "terminal";
      run.remoteStatus = "not_sent";
      run.resultStatus = "CANCELLED_BEFORE_SEND";
      run.completedAt = this.now();
      run.updatedAt = this.now();
      delete run.childPid;
      delete run.processFingerprint;
      delete run.processStartedAt;
      if (session.activeRunId === runId) delete session.activeRunId;
      session.status = "idle";
      session.updatedAt = this.now();
      delete state.reservations[run.workspaceHash];
    });
  }
  async _createOrReuseProcess(session, runtimePath) {
    let managed = this.processes.get(session.sessionId);
    if (managed && !["ready", "turn_active"].includes(managed.runtimeState)) {
      this.processes.delete(session.sessionId);
      await managed.close().catch(() => {
      });
      managed = null;
    }
    if (managed) return managed;
    const agyEnvironment = this.environmentLoader ? await this.environmentLoader(this.paths) : this.agyEnvironment;
    if (!agyEnvironment || typeof agyEnvironment !== "object" || Array.isArray(agyEnvironment)) {
      throw new SupervisorFault("ENVIRONMENT_UNAVAILABLE");
    }
    managed = new this.SessionProcess({
      agyPath: runtimePath,
      cwd: session.cwd,
      conversationId: session.conversationId || null,
      model: session.model,
      effort: session.effort,
      env: agyEnvironment,
      beforeSpawn: () => this.verifier.verify({ agyPath: runtimePath }),
      onActivity: (event) => {
        const flags = this.activity.get(this.activeRunBySession.get(session.sessionId));
        if (!flags) return;
        if (event.type === "permission_denied" || event.permissionDenied) flags.permissionDeniedSeen = true;
        if ((event.type === "tool_info" || event.type === "tool_step") && event.hasError) flags.toolFailureSeen = true;
      }
    });
    this.processes.set(session.sessionId, managed);
    return managed;
  }
  async _executeTurn(sessionId, runId, prompt) {
    let managed;
    let promptMayHaveBeenSent = false;
    try {
      let runtime = await this.runtimePreparer({
        sourcePath: this.agyPath,
        stateDir: this.paths.stateDir,
        verifier: this.verifier
      });
      if (!runtime?.ok) throw new SupervisorFault(runtime?.failureKind || "RUNTIME_GATE_FAILED");
      const runtimePath = runtime.executionPath;
      if (!runtimePath) throw new SupervisorFault("RUNTIME_EXECUTION_PATH_UNAVAILABLE");
      if (await this._runWasCancelled(runId)) {
        await this._cancelBeforeSend(sessionId, runId);
        return;
      }
      let state = await this._phase(sessionId, runId, "process_start", "running", {
        remoteStatus: "not_sent"
      });
      let session = state.sessions[sessionId];
      if (!session || session.activeRunId !== runId) return;
      managed = await this._createOrReuseProcess(session, runtimePath);
      const init = await managed.start();
      runtime = managed.runtimeReport || runtime;
      const identity = await this.processProbe(managed.pid).catch(() => null);
      state = await this._update((draft) => {
        const currentSession = draft.sessions[sessionId];
        const run = draft.runs[runId];
        if (!currentSession || !run || currentSession.activeRunId !== runId) return;
        currentSession.pendingConversationId = init.conversationId;
        currentSession.permissionMode = init.permissionMode;
        currentSession.runtimeVersion = runtime.version;
        currentSession.runtimeSha256 = runtime.sha256;
        currentSession.runtimeSignatureStatus = runtime.signer;
        currentSession.updatedAt = this.now();
        run.childPid = managed.pid;
        if (identity?.fingerprint) run.processFingerprint = identity.fingerprint;
        if (identity?.createdAt) run.processStartedAt = identity.createdAt;
        run.phase = "ready_to_send";
        run.updatedAt = this.now();
      });
      session = state.sessions[sessionId];
      if (!session || session.activeRunId !== runId || await this._runWasCancelled(runId)) {
        await managed.close().catch(() => {
        });
        this.processes.delete(sessionId);
        await this._cancelBeforeSend(sessionId, runId);
        return;
      }
      await this._phase(sessionId, runId, "turn_active", "running", {
        remoteStatus: "active"
      });
      promptMayHaveBeenSent = true;
      const output = await managed.sendTurn(prompt);
      const response = output.response || "";
      const flags = this.activity.get(runId) || {};
      this._rememberResult(runId, response);
      await this._update((draft) => {
        const currentSession = draft.sessions[sessionId];
        const run = draft.runs[runId];
        if (!currentSession || !run) return;
        const returnedId = output.metadata?.conversationId;
        if (currentSession.conversationId && currentSession.conversationId !== returnedId) {
          throw new SupervisorFault("CONVERSATION_MISMATCH");
        }
        currentSession.conversationId = returnedId;
        delete currentSession.pendingConversationId;
        delete currentSession.activeRunId;
        currentSession.status = "idle";
        currentSession.effortStatus = output.metadata?.effortStatus || "ACCEPTED_NOT_ATTESTED";
        currentSession.permissionMode = output.metadata?.permissionMode || "always-proceed";
        currentSession.updatedAt = this.now();
        run.status = "completed";
        run.phase = "terminal";
        run.resultStatus = "SUCCESS";
        run.remoteStatus = "terminal";
        run.resultSha256 = resultDigest(response);
        run.resultBytes = Buffer.byteLength(response, "utf8");
        run.resultTruncated = Boolean(output.responseTruncated);
        run.permissionDeniedSeen = Boolean(flags.permissionDeniedSeen);
        run.toolFailureSeen = Boolean(flags.toolFailureSeen);
        run.completedAt = this.now();
        run.updatedAt = this.now();
        delete run.childPid;
        delete run.processFingerprint;
        delete run.processStartedAt;
        delete draft.reservations[run.workspaceHash];
      });
    } catch (error) {
      const errorKind = fixedKind(error);
      const flags = this.activity.get(runId) || {};
      const wasCancelled = await this._runWasCancelled(runId).catch(() => false);
      const knownTerminalFailure = errorKind === "TOOL_FAILURE" || errorKind === "TURN_NOT_SUCCESSFUL";
      const uncertain = wasCancelled || promptMayHaveBeenSent && !knownTerminalFailure;
      let closeState = null;
      this.memoryResults.delete(runId);
      if (!managed && /^(?:HASH_MISMATCH|UNSUPPORTED_VERSION|SIGNATURE_UNVERIFIED|RUNTIME_(?:SNAPSHOT|CHANGED)|MISSING_REQUIRED_FLAGS)/u.test(errorKind)) {
        managed = this.processes.get(sessionId);
      }
      if (managed && errorKind !== "TOOL_FAILURE") {
        closeState = await managed.close().catch(() => null);
        this.processes.delete(sessionId);
      }
      await this._update((state) => {
        const session = state.sessions[sessionId];
        const run = state.runs[runId];
        if (!session || !run || TERMINAL_RUN_STATUSES.has(run.status)) return;
        run.status = uncertain ? "needs_attention" : "failed";
        run.phase = "terminal";
        run.errorKind = uncertain ? wasCancelled ? "CANCELLED_OUTCOME_UNKNOWN" : "TURN_OUTCOME_UNKNOWN" : errorKind;
        if (uncertain) run.failureKind = errorKind;
        run.remoteStatus = uncertain ? closeState?.remoteStatus === "exited" ? "exited_without_terminal" : "remote_unknown" : knownTerminalFailure ? "terminal_failure" : "not_sent";
        run.resultStatus = uncertain ? "UNKNOWN" : "FAILED";
        run.permissionDeniedSeen = Boolean(flags.permissionDeniedSeen);
        run.toolFailureSeen = Boolean(flags.toolFailureSeen || errorKind === "TOOL_FAILURE");
        run.completedAt = this.now();
        run.updatedAt = this.now();
        if (!uncertain) {
          delete run.childPid;
          delete run.processFingerprint;
          delete run.processStartedAt;
        }
        if (session.activeRunId === runId) delete session.activeRunId;
        delete session.pendingConversationId;
        session.status = uncertain ? "needs_attention" : /^(?:UNSUPPORTED_VERSION|HASH_MISMATCH|SIGNATURE_UNVERIFIED|RUNTIME_SNAPSHOT|RUNTIME_CHANGED)/u.test(errorKind) ? "update_pending_compatibility" : "needs_attention";
        session.updatedAt = this.now();
        if (!uncertain) delete state.reservations[run.workspaceHash];
      }).catch(() => {
      });
    } finally {
      this.activity.delete(runId);
      if (this.activeRunBySession.get(sessionId) === runId) this.activeRunBySession.delete(sessionId);
    }
  }
  async inspect(params = {}) {
    const waitMs = Number.isInteger(params.waitMs) ? params.waitMs : 0;
    const state = await this._waitForRevision(params.afterRevision, waitMs);
    const sessionId = params.sessionId;
    const runId = params.runId;
    if (sessionId && !state.sessions[sessionId]) fail("SESSION_NOT_FOUND");
    if (runId && !state.runs[runId]) fail("RUN_NOT_FOUND");
    const run = runId ? state.runs[runId] : null;
    if (sessionId && run && run.sessionId !== sessionId) fail("RUN_SESSION_MISMATCH");
    if (sessionId || runId) {
      const selectedSession = state.sessions[sessionId || run.sessionId];
      return {
        revision: state.revision || 0,
        epochId: state.epochId || null,
        daemon: {
          protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
          runtimeVersion: SUPERVISOR_RUNTIME_VERSION
        },
        session: publicSession(selectedSession),
        run: publicRun(run || (selectedSession?.activeRunId ? state.runs[selectedSession.activeRunId] : null), runId ? this.memoryResults.get(runId) : void 0)
      };
    }
    const sessions = Object.values(state.sessions).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0, 20).map(publicSession);
    return {
      revision: state.revision || 0,
      epochId: state.epochId || null,
      daemon: {
        protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
        runtimeVersion: SUPERVISOR_RUNTIME_VERSION
      },
      sessions,
      omittedSessions: Math.max(0, Object.keys(state.sessions).length - sessions.length)
    };
  }
  async control(params = {}) {
    if (params.confirmation !== "CONTROL_AGY_SESSION") fail("CONFIRMATION_REQUIRED");
    if (!validIdentifier(params.sessionId)) fail("SESSION_ID_REQUIRED");
    return this._serialize(async () => {
      const state = await this.store.snapshot();
      const session = state.sessions[params.sessionId];
      if (!session) fail("SESSION_NOT_FOUND");
      if (params.action === "cancel_turn") {
        if (!validIdentifier(params.runId)) fail("RUN_ID_REQUIRED");
        const run = state.runs[params.runId];
        if (!run || run.sessionId !== session.sessionId || session.activeRunId !== run.runId) fail("ACTIVE_RUN_NOT_FOUND");
        await this._update((draft) => {
          const current = draft.runs[run.runId];
          current.status = "cancel_requested";
          current.phase = "cancel_requested";
          current.cancelRequestedAt = this.now();
          current.updatedAt = this.now();
          draft.sessions[session.sessionId].status = "cancel_requested";
          draft.sessions[session.sessionId].updatedAt = this.now();
        });
        const managed = this.processes.get(session.sessionId);
        const cancellation = managed ? await managed.cancelCurrentTurn() : { status: "cancel_requested", remoteStatus: "remote_unknown" };
        if (managed && cancellation.status === "no_active_turn") {
          await managed.close().catch(() => {
          });
          this.processes.delete(session.sessionId);
        }
        return { accepted: true, ...cancellation };
      }
      if (params.action === "acknowledge_uncertain") {
        if (!validIdentifier(params.runId)) fail("RUN_ID_REQUIRED");
        const run = state.runs[params.runId];
        if (!run || run.sessionId !== session.sessionId) fail("RUN_NOT_FOUND");
        if (run.status !== "unknown_after_restart" && run.status !== "needs_attention" && run.remoteStatus !== "remote_unknown") {
          fail("RUN_NOT_UNCERTAIN");
        }
        const recoveryProcessId = run.recoveryProcessId || run.childPid;
        if (recoveryProcessId) {
          const proof = await this.processProbe(recoveryProcessId).catch(() => ({ alive: true, fingerprint: null }));
          if (proof?.alive && (!run.processFingerprint || !proof.fingerprint)) fail("ORPHAN_PROCESS_STATUS_UNKNOWN");
          if (proof?.alive && proof.fingerprint === run.processFingerprint) fail("ORPHAN_PROCESS_STILL_RUNNING");
        }
        const next = await this._update((draft) => {
          const current = draft.runs[run.runId];
          current.status = "acknowledged_uncertain";
          current.phase = "terminal";
          current.remoteStatus = "acknowledged_unknown";
          current.updatedAt = this.now();
          delete current.recoveryProcessId;
          delete current.childPid;
          delete current.processFingerprint;
          delete current.processStartedAt;
          const currentSession = draft.sessions[session.sessionId];
          currentSession.status = "idle";
          delete currentSession.activeRunId;
          currentSession.updatedAt = this.now();
          delete draft.reservations[current.workspaceHash];
        });
        return { accepted: true, revision: next.revision, session: publicSession(next.sessions[session.sessionId]), run: publicRun(next.runs[run.runId]) };
      }
      if (params.action === "close_session") {
        if (session.activeRunId) fail("SESSION_BUSY");
        if (this._hasUnacknowledgedRun(state, session.sessionId)) fail("UNCERTAIN_RUN_ACK_REQUIRED");
        const managed = this.processes.get(session.sessionId);
        const close = managed ? await managed.close() : { status: "closed", remoteStatus: "not_running" };
        if (close.status === "close_pending") fail("CLOSE_REMOTE_UNKNOWN");
        this.processes.delete(session.sessionId);
        const next = await this._update((draft) => {
          const current = draft.sessions[session.sessionId];
          current.status = "closed";
          current.closedAt = this.now();
          current.updatedAt = this.now();
        });
        return { accepted: true, revision: next.revision, session: publicSession(next.sessions[session.sessionId]), close };
      }
      fail("INVALID_CONTROL_ACTION");
    });
  }
  async handleRequest({ method, params }) {
    switch (method) {
      case "startTurn":
        return this.startTurn(params);
      case "inspect":
        return this.inspect(params);
      case "control":
        return this.control(params);
      default:
        fail("METHOD_NOT_FOUND");
    }
  }
  async shutdown() {
    const closers = [];
    for (const managed of this.processes.values()) closers.push(managed.close().catch(() => {
    }));
    await Promise.all(closers);
    this.processes.clear();
  }
};
function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
async function loadBootstrapEnvironment(paths, { proxyResolver = readWindowsUserProxyEnvironment } = {}) {
  let stored = {};
  try {
    const parsed = JSON.parse(await readFile3(paths.bootstrapEnvPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
  } catch {
  }
  const environment = buildSafeAgyEnvironment(stored);
  const ordinaryUserProfile = path3.isAbsolute(environment.USERPROFILE || "") ? environment.USERPROFILE : homedir2();
  const localAppData = path3.isAbsolute(environment.LOCALAPPDATA || "") ? environment.LOCALAPPDATA : path3.join(ordinaryUserProfile, "AppData", "Local");
  const appData = path3.isAbsolute(environment.APPDATA || "") ? environment.APPDATA : path3.join(ordinaryUserProfile, "AppData", "Roaming");
  environment.LOCALAPPDATA = localAppData;
  environment.APPDATA = appData;
  environment.USERPROFILE = ordinaryUserProfile;
  environment.HOME = path3.isAbsolute(environment.HOME || "") ? environment.HOME : ordinaryUserProfile;
  const profileRoot = path3.parse(ordinaryUserProfile).root;
  if (/^[A-Za-z]:\\$/u.test(profileRoot)) {
    environment.HOMEDRIVE = profileRoot.slice(0, 2);
    environment.HOMEPATH = ordinaryUserProfile.slice(2);
  }
  const discoveredProxy = typeof proxyResolver === "function" ? await proxyResolver({ env: environment }).catch(() => ({})) : {};
  if (!environment.HTTP_PROXY && discoveredProxy?.HTTP_PROXY) environment.HTTP_PROXY = discoveredProxy.HTTP_PROXY;
  if (!environment.HTTPS_PROXY && discoveredProxy?.HTTPS_PROXY) environment.HTTPS_PROXY = discoveredProxy.HTTPS_PROXY;
  environment.CI = "true";
  environment.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  return buildSafeAgyEnvironment(environment);
}
async function main() {
  const requestedStateDir = argumentValue("--state-dir");
  const paths = requestedStateDir ? getSupervisorPaths({ stateDir: path3.resolve(requestedStateDir) }) : getSupervisorPaths();
  if (requestedStateDir && canonicalWorkspace(requestedStateDir) !== canonicalWorkspace(paths.stateDir)) process.exit(2);
  const token = await ensureSupervisorToken(paths);
  const agyEnvironment = await loadBootstrapEnvironment(paths);
  const sourceAgyPath = defaultAgyPath({ env: agyEnvironment });
  if (!sourceAgyPath) process.exit(2);
  const epoch = randomUUID4();
  let controller = null;
  const transport = await createSupervisorServer({
    paths,
    token,
    epoch,
    pingResult: () => ({ ready: Boolean(controller), daemonPid: process.pid }),
    handleRequest: (request) => {
      if (!controller) fail("DAEMON_STARTING");
      return controller.handleRequest(request);
    }
  });
  try {
    controller = await new AgySupervisorController({
      paths,
      agyPath: sourceAgyPath,
      agyEnvironment,
      environmentLoader: () => loadBootstrapEnvironment(paths)
    }).initialize(epoch);
  } catch (error) {
    await transport.close().catch(() => {
    });
    throw error;
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await transport.close().catch(() => {
    });
    if (controller) await controller.shutdown().catch(() => {
    });
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
var invokedPath = process.argv[1] ? path3.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === path3.resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => process.exit(1));
}
export {
  AgySupervisorController,
  loadBootstrapEnvironment
};
