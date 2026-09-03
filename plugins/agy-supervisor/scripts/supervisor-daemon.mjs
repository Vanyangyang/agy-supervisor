#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgySessionProcess,
  DEFAULT_AGY_EFFORT,
  DEFAULT_AGY_MODEL,
} from "./agy-runner.mjs";
import {
  buildSafeAgyEnvironment,
  createRuntimeVerifier,
  defaultAgyPath,
  readWindowsUserProxyEnvironment,
} from "./agy-runtime.mjs";
import { inspectProcessIdentity } from "./process-identity.mjs";
import { prepareManagedRuntime } from "./runtime-snapshot.mjs";
import {
  canonicalWorkspace,
  hashPrompt,
  StateStore,
} from "./state-store.mjs";
import {
  createSupervisorServer,
  ensureSupervisorToken,
  getSupervisorPaths,
  SUPERVISOR_PROTOCOL_VERSION,
  SUPERVISOR_RUNTIME_VERSION,
} from "./supervisor-transport.mjs";

const MAX_PROMPT_BYTES = 48_000;
const MAX_MEMORY_RESULTS = 100;
const MAX_DURABLE_RUNS = 500;
const MAX_DURABLE_SESSIONS = 200;
const MAX_IDEMPOTENCY_TOMBSTONES = 500;
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled_before_send",
  "acknowledged_uncertain",
]);

class SupervisorFault extends Error {
  constructor(kind) {
    super(kind);
    this.name = "SupervisorFault";
    this.kind = kind;
    this.code = kind;
  }
}

function fail(kind) {
  throw new SupervisorFault(kind);
}

function fixedKind(error, fallback = "TURN_FAILED") {
  const value = error?.kind || error?.code;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,95}$/u.test(value) ? value : fallback;
}

function workspaceDigest(cwd) {
  return createHash("sha256").update(canonicalWorkspace(cwd), "utf8").digest("hex");
}

function resultDigest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function operationDigest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function compactDurableHistory(state) {
  state.requestTombstones ||= {};
  const removableRuns = Object.values(state.runs)
    .filter((run) => TERMINAL_RUN_STATUSES.has(run.status) || run.status === "failed")
    .sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
  while (Object.keys(state.runs).length > MAX_DURABLE_RUNS && removableRuns.length) {
    const run = removableRuns.shift();
    if (run.requestId && run.intentSha256) {
      state.requestTombstones[operationDigest(run.requestId)] = {
        requestId: run.requestId,
        intentSha256: run.intentSha256,
        runId: run.runId,
        sessionId: run.sessionId,
        status: run.status,
        updatedAt: run.updatedAt,
      };
    }
    delete state.runs[run.runId];
  }

  const tombstones = Object.entries(state.requestTombstones)
    .sort(([, left], [, right]) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
  while (tombstones.length > MAX_IDEMPOTENCY_TOMBSTONES) {
    const [key] = tombstones.shift();
    delete state.requestTombstones[key];
  }

  const referencedSessions = new Set(Object.values(state.runs).map((run) => run.sessionId));
  const removableSessions = Object.values(state.sessions)
    .filter((session) => session.status === "closed" && !referencedSessions.has(session.sessionId))
    .sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
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
    recoveredAt: session.recoveredAt || null,
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
    resultAvailable: memoryResult !== undefined,
  };
  if (memoryResult !== undefined) value.result = memoryResult;
  return value;
}

export class AgySupervisorController {
  constructor({
    paths = getSupervisorPaths(),
    statePath = path.join(paths.stateDir, "state.json"),
    verifier = createRuntimeVerifier(),
    SessionProcess = AgySessionProcess,
    agyPath = defaultAgyPath(),
    processProbe = inspectProcessIdentity,
    runtimePreparer = prepareManagedRuntime,
    agyEnvironment = process.env,
    environmentLoader = null,
    now = () => new Date().toISOString(),
    uuid = randomUUID,
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
    this.processes = new Map();
    this.memoryResults = new Map();
    this.activity = new Map();
    this.activeRunBySession = new Map();
    this.waiters = new Set();
    this.controlTail = Promise.resolve();
  }

  async initialize(epoch) {
    this.epoch = epoch;
    await this.store.load();
    await this._update((state) => {
      state.epochId = epoch;
      for (const session of Object.values(state.sessions)) delete session.pendingConversationId;
      for (const run of Object.values(state.runs)) {
        if (run.status === "unknown_after_restart" && (
          run.recoveryProcessId || (run.remoteStatus !== "not_started" && run.remoteStatus !== "not_sent")
        )) {
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
    this.controlTail = pending.catch(() => {});
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
    const changed = new Promise((resolveWait) => { settle = resolveWait; });
    const onRevision = (revision) => {
      if (revision > afterRevision) settle();
    };
    this.waiters.add(onRevision);
    const second = await this.store.snapshot();
    if (second.revision > afterRevision) settle();
    const timer = setTimeout(settle, Math.min(25_000, Math.max(0, waitMs)));
    await changed;
    clearTimeout(timer);
    this.waiters.delete(onRevision);
    return this.store.snapshot();
  }

  async _resolveWorkspace(value) {
    if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) fail("INVALID_WORKSPACE");
    let cwd;
    let info;
    try {
      cwd = await realpath(value);
      info = await stat(cwd);
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
    return Object.values(state.runs).some((run) => run.sessionId === sessionId && (
      run.status === "unknown_after_restart" ||
      run.status === "needs_attention" ||
      run.remoteStatus === "remote_unknown"
    ));
  }

  async startTurn(params = {}) {
    if (params.confirmation !== "SEND_TO_AGY") fail("CONFIRMATION_REQUIRED");
    if (params.mode !== "new" && params.mode !== "resume") fail("INVALID_MODE");
    if (typeof params.prompt !== "string" || !params.prompt.length) fail("INVALID_PROMPT");
    const request = hashPrompt(params.prompt);
    if (request.bytes > MAX_PROMPT_BYTES) fail("PROMPT_TOO_LARGE");
    const workspace = await this._resolveWorkspace(params.cwd);
    if (params.requestId !== undefined && !validIdentifier(params.requestId)) fail("INVALID_REQUEST_ID");
    const requestId = params.requestId || this.uuid();

    return this._serialize(async () => {
      const current = await this.store.snapshot();
      let sessionId = params.mode === "resume" ? params.sessionId : null;
      let selectedModel;
      let selectedEffort;
      if (params.mode === "new") {
        if (params.sessionId !== undefined) fail("NEW_SESSION_ID_NOT_ALLOWED");
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
        effort: selectedEffort,
      });
      const prior = Object.values(current.runs).find((run) => run.requestId === requestId);
      if (prior) {
        if (prior.intentSha256 !== intentSha256) fail("REQUEST_ID_CONFLICT");
        return {
          accepted: true,
          reused: true,
          revision: current.revision || 0,
          session: publicSession(current.sessions[prior.sessionId]),
          run: publicRun(prior, this.memoryResults.get(prior.runId)),
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
          status: tombstone.status,
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
            updatedAt: startedAt,
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
          updatedAt: startedAt,
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
        run: publicRun(next.runs[runId]),
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
      await managed.close().catch(() => {});
      managed = null;
    }
    if (managed) return managed;

    const agyEnvironment = this.environmentLoader
      ? await this.environmentLoader(this.paths)
      : this.agyEnvironment;
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
      },
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
        verifier: this.verifier,
      });
      if (!runtime?.ok) throw new SupervisorFault(runtime?.failureKind || "RUNTIME_GATE_FAILED");
      const runtimePath = runtime.executionPath;
      if (!runtimePath) throw new SupervisorFault("RUNTIME_EXECUTION_PATH_UNAVAILABLE");
      if (await this._runWasCancelled(runId)) {
        await this._cancelBeforeSend(sessionId, runId);
        return;
      }

      let state = await this._phase(sessionId, runId, "process_start", "running", {
        remoteStatus: "not_sent",
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
        await managed.close().catch(() => {});
        this.processes.delete(sessionId);
        await this._cancelBeforeSend(sessionId, runId);
        return;
      }

      await this._phase(sessionId, runId, "turn_active", "running", {
        remoteStatus: "active",
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
      const uncertain = wasCancelled || (promptMayHaveBeenSent && !knownTerminalFailure);
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
        run.errorKind = uncertain
          ? (wasCancelled ? "CANCELLED_OUTCOME_UNKNOWN" : "TURN_OUTCOME_UNKNOWN")
          : errorKind;
        if (uncertain) run.failureKind = errorKind;
        run.remoteStatus = uncertain
          ? (closeState?.remoteStatus === "exited" ? "exited_without_terminal" : "remote_unknown")
          : (knownTerminalFailure ? "terminal_failure" : "not_sent");
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
        session.status = uncertain ? "needs_attention" : (
          /^(?:UNSUPPORTED_VERSION|HASH_MISMATCH|SIGNATURE_UNVERIFIED|RUNTIME_SNAPSHOT|RUNTIME_CHANGED)/u.test(errorKind)
            ? "update_pending_compatibility"
            : "needs_attention"
        );
        session.updatedAt = this.now();
        if (!uncertain) delete state.reservations[run.workspaceHash];
      }).catch(() => {});
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
          runtimeVersion: SUPERVISOR_RUNTIME_VERSION,
        },
        session: publicSession(selectedSession),
        run: publicRun(run || (selectedSession?.activeRunId ? state.runs[selectedSession.activeRunId] : null), runId ? this.memoryResults.get(runId) : undefined),
      };
    }

    const sessions = Object.values(state.sessions)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, 20)
      .map(publicSession);
    return {
      revision: state.revision || 0,
      epochId: state.epochId || null,
      daemon: {
        protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
        runtimeVersion: SUPERVISOR_RUNTIME_VERSION,
      },
      sessions,
      omittedSessions: Math.max(0, Object.keys(state.sessions).length - sessions.length),
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
        const cancellation = managed
          ? await managed.cancelCurrentTurn()
          : { status: "cancel_requested", remoteStatus: "remote_unknown" };
        if (managed && cancellation.status === "no_active_turn") {
          await managed.close().catch(() => {});
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
      case "startTurn": return this.startTurn(params);
      case "inspect": return this.inspect(params);
      case "control": return this.control(params);
      default: fail("METHOD_NOT_FOUND");
    }
  }

  async shutdown() {
    const closers = [];
    for (const managed of this.processes.values()) closers.push(managed.close().catch(() => {}));
    await Promise.all(closers);
    this.processes.clear();
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

export async function loadBootstrapEnvironment(paths, { proxyResolver = readWindowsUserProxyEnvironment } = {}) {
  let stored = {};
  try {
    const parsed = JSON.parse(await readFile(paths.bootstrapEnvPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
  } catch {
    // A missing or malformed bootstrap never widens the inherited environment.
  }
  const environment = buildSafeAgyEnvironment(stored);
  const ordinaryUserProfile = path.isAbsolute(environment.USERPROFILE || "")
    ? environment.USERPROFILE
    : homedir();
  const localAppData = path.isAbsolute(environment.LOCALAPPDATA || "")
    ? environment.LOCALAPPDATA
    : path.join(ordinaryUserProfile, "AppData", "Local");
  const appData = path.isAbsolute(environment.APPDATA || "")
    ? environment.APPDATA
    : path.join(ordinaryUserProfile, "AppData", "Roaming");
  environment.LOCALAPPDATA = localAppData;
  environment.APPDATA = appData;
  environment.USERPROFILE = ordinaryUserProfile;
  environment.HOME = path.isAbsolute(environment.HOME || "") ? environment.HOME : ordinaryUserProfile;
  const profileRoot = path.parse(ordinaryUserProfile).root;
  if (/^[A-Za-z]:\\$/u.test(profileRoot)) {
    environment.HOMEDRIVE = profileRoot.slice(0, 2);
    environment.HOMEPATH = ordinaryUserProfile.slice(2);
  }
  const discoveredProxy = typeof proxyResolver === "function"
    ? await proxyResolver({ env: environment }).catch(() => ({}))
    : {};
  if (!environment.HTTP_PROXY && discoveredProxy?.HTTP_PROXY) environment.HTTP_PROXY = discoveredProxy.HTTP_PROXY;
  if (!environment.HTTPS_PROXY && discoveredProxy?.HTTPS_PROXY) environment.HTTPS_PROXY = discoveredProxy.HTTPS_PROXY;
  environment.CI = "true";
  environment.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  return buildSafeAgyEnvironment(environment);
}

async function main() {
  const requestedStateDir = argumentValue("--state-dir");
  const paths = requestedStateDir
    ? getSupervisorPaths({ stateDir: path.resolve(requestedStateDir) })
    : getSupervisorPaths();
  if (requestedStateDir && canonicalWorkspace(requestedStateDir) !== canonicalWorkspace(paths.stateDir)) process.exit(2);
  const token = await ensureSupervisorToken(paths);
  const agyEnvironment = await loadBootstrapEnvironment(paths);
  const sourceAgyPath = defaultAgyPath({ env: agyEnvironment });
  if (!sourceAgyPath) process.exit(2);
  const epoch = randomUUID();
  let controller = null;
  const transport = await createSupervisorServer({
    paths,
    token,
    epoch,
    pingResult: () => ({ ready: Boolean(controller), daemonPid: process.pid }),
    handleRequest: (request) => {
      if (!controller) fail("DAEMON_STARTING");
      return controller.handleRequest(request);
    },
  });
  try {
    controller = await new AgySupervisorController({
      paths,
      agyPath: sourceAgyPath,
      agyEnvironment,
      environmentLoader: () => loadBootstrapEnvironment(paths),
    }).initialize(epoch);
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await transport.close().catch(() => {});
    if (controller) await controller.shutdown().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => process.exit(1));
}
