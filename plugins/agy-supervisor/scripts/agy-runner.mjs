import { spawn as nodeSpawn } from "node:child_process";
import { realpath as nodeRealpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  buildSafeAgyEnvironment,
  classifyAgyStderr,
  DEFAULT_AGY_EFFORT,
  DEFAULT_AGY_MODEL,
  defaultAgyPath,
  SUPPORTED_AGY_EFFORTS,
} from "./agy-runtime.mjs";

export {
  createRuntimeVerifier,
  DEFAULT_AGY_EFFORT,
  DEFAULT_AGY_MODEL,
  defaultAgyPath,
} from "./agy-runtime.mjs";

export const AGY_MODEL_ATTESTATION_TIMING = "INIT_BEFORE_PROMPT";
export const AGY_EFFORT_STATUS = "ACCEPTED_NOT_ATTESTED";
export const AGY_PERMISSION_MODE = "always-proceed";

const DEFAULT_INIT_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_LINE_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 8 * 1024;
const DEFAULT_MAX_RESPONSE_CHARS = 8_000;
const DEFAULT_MAX_PROMPT_BYTES = 64 * 1024;
const DEFAULT_MAX_EVENTS = 4_096;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class AgySessionError extends Error {
  constructor(code) {
    super(code);
    this.name = "AgySessionError";
    this.code = code;
  }
}

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
  return undefined;
}

function eventName(value) {
  const name = field(value, ["event", "type"]);
  return typeof name === "string" ? name : null;
}

function canonicalKey(value, platform) {
  const normalized = resolve(value).replace(/[\\/]+/g, platform === "win32" ? "\\" : "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizedResponse(value) {
  return typeof value === "string"
    ? value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim()
    : "";
}

function boundedResponse(value, maximum) {
  const normalized = normalizedResponse(value);
  return {
    text: normalized.length > maximum ? `${normalized.slice(0, maximum)}…` : normalized,
    truncated: normalized.length > maximum,
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
    permissionDenied: info.permission_denied === true || info.permissionDenied === true
      || String(info.permission_denied || "").toLowerCase() === "true"
      || String(info.permissionDenied || "").toLowerCase() === "true"
      || /denied/i.test(permission),
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
      },
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

export class AgySessionProcess {
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
    onActivity = () => {},
    realpathImpl = nodeRealpath,
    platform = process.platform,
  } = {}) {
    this._agyPath = typeof agyPath === "string" && agyPath.trim() ? agyPath : null;
    this._cwd = typeof cwd === "string" && cwd.trim() && isAbsolute(cwd) ? cwd : null;
    this._requestedConversationId = conversationId === null ? null : exactOpaqueId(conversationId);
    this._conversationIdInvalid = conversationId !== null && this._requestedConversationId === null;
    this._model = exactModel(model);
    this._effort = SUPPORTED_AGY_EFFORTS.includes(effort) ? effort : null;
    this._env = buildSafeAgyEnvironment(env);
    this._spawnImpl = typeof spawnImpl === "function" ? spawnImpl : null;
    this._beforeSpawn = beforeSpawn === null || typeof beforeSpawn === "function" ? beforeSpawn : undefined;
    this._initTimeoutMs = boundedNumber(initTimeoutMs, DEFAULT_INIT_TIMEOUT_MS, 100, 30_000);
    this._closeTimeoutMs = boundedNumber(closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 100, 30_000);
    this._cancelTimeoutMs = boundedNumber(cancelTimeoutMs, DEFAULT_CANCEL_TIMEOUT_MS, 100, 30_000);
    this._maxLineBytes = boundedNumber(maxLineBytes, DEFAULT_MAX_LINE_BYTES, 128, 512 * 1024);
    this._maxOutputBytes = boundedNumber(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, this._maxLineBytes, 4 * 1024 * 1024);
    this._maxStderrBytes = boundedNumber(maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, 128, 64 * 1024);
    this._maxResponseChars = boundedNumber(maxResponseChars, DEFAULT_MAX_RESPONSE_CHARS, 1, 32_000);
    this._maxPromptBytes = boundedNumber(maxPromptBytes, DEFAULT_MAX_PROMPT_BYTES, 1, 1024 * 1024);
    this._maxEvents = boundedNumber(maxEvents, DEFAULT_MAX_EVENTS, 1, 8_192);
    this._onActivity = typeof onActivity === "function" ? onActivity : () => {};
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
    // These are intentionally per startup/turn windows, not lifetime counters.
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
      // Activity observers must not affect the supervised process.
    }
  }

  async _canonicalize(path) {
    if (typeof path !== "string" || !path.trim() || !isAbsolute(path) || !this._realpath) return null;
    try {
      return await this._realpath(path);
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
      "--dangerously-skip-permissions",
    ];
    if (this._requestedConversationId) args.push("--conversation", this._requestedConversationId);
    return args;
  }

  _validateConfiguration() {
    if (!this._agyPath || !this._cwd || !this._model || !this._effort || !this._spawnImpl || !this._realpath || this._beforeSpawn === undefined) {
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
        signal: typeof signal === "string" ? signal : null,
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
      const newline = this._stdoutBuffer.indexOf(0x0a);
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
    if (!line.length || line.every((byte) => byte === 0x0d || byte === 0x20 || byte === 0x09)) return;
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
    this._eventChain = this._eventChain
      .then(() => this._processEvent(value))
      .catch((error) => this._fail(asSessionError(error, "PROTOCOL_ERROR")));
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
    if (!receivedConversationId || (this._requestedConversationId && receivedConversationId !== this._requestedConversationId)) {
      throw new AgySessionError("INIT_CONVERSATION_MISMATCH");
    }

    this._conversationId = receivedConversationId;
    this._init = {
      cwd: this._cwd,
      model: this._model,
      permissionMode: AGY_PERMISSION_MODE,
      conversationId: receivedConversationId,
      modelAttestationTiming: AGY_MODEL_ATTESTATION_TIMING,
      effortStatus: AGY_EFFORT_STATUS,
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
      effortStatus: AGY_EFFORT_STATUS,
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
    // Keep the complete terminal reply only for the in-flight opt-in delivery path.
    // The ordinary returned response remains bounded before it enters daemon memory.
    const fullResponse = normalizedResponse(resultContent(value));
    const response = boundedResponse(fullResponse, this._maxResponseChars);
    this._turn = null;
    this._state = "ready";
    turn.deferred.resolve({
      status: "SUCCESS",
      response: response.text,
      responseTruncated: response.truncated,
      ...(turn.captureFullResponse ? { fullResponse } : {}),
      metadata: {
        conversationId: this._conversationId,
        model: this._model,
        permissionMode: AGY_PERMISSION_MODE,
        effort: this._effort,
        effortStatus: AGY_EFFORT_STATUS,
        modelAttestationTiming: AGY_MODEL_ATTESTATION_TIMING,
        cancelRequested: turn.cancelRequested,
      },
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
      const error = this._turn.cancelRequested
        ? new AgySessionError("TURN_CANCELLED")
        : new AgySessionError(classifyAgyStderr(this._stderr));
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
        // The exact owned child may already have exited.
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
        windowsHide: true,
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

  async sendTurn(prompt, { captureFullResponse = false } = {}) {
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
        cancelRequested: false,
        captureFullResponse: captureFullResponse === true,
      };
      this._turn = turn;
      this._state = "turn_active";
      this._activity({ type: "turn_started", conversationId: this._conversationId });
      try {
        await writeLine(this._child.stdin, `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`);
      } catch (error) {
        this._rejectTurn(error);
        throw asSessionError(error);
      }
      const result = await turn.deferred.promise;
      return result;
    };
    const queued = this._turnQueue.catch(() => undefined).then(run);
    this._turnQueue = queued.catch(() => undefined);
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
      // Exit handling remains the source of truth.
    }
    const exit = await waitFor(this._exitDeferred.promise, this._closeTimeoutMs);
    return exit
      ? { status: "closed", remoteStatus: "exited" }
      : { status: "close_pending", remoteStatus: "remote_unknown" };
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
      // The exact owned child may have reached exit concurrently.
    }
    clearTimeout(this._cancelTimer);
    this._cancelTimer = setTimeout(() => {
      if (this._turn?.cancelRequested && !this._exitInfo) this._fail(new AgySessionError("CANCEL_TIMEOUT"));
    }, this._cancelTimeoutMs);
    this._activity({ type: "cancel_requested", conversationId: this._conversationId });
    return { status: "cancel_requested", remoteStatus: "remote_unknown", killAccepted };
  }
}
