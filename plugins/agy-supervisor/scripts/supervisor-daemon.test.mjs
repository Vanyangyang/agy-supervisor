import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgySupervisorController, loadBootstrapEnvironment } from "./supervisor-daemon.mjs";
import { canonicalWorkspace, hashPrompt } from "./state-store.mjs";
import { createHash } from "node:crypto";

const runtime = {
  ok: true,
  status: "READY",
  version: "1.1.25",
  sha256: "DBC665F942B59E56A0D3317AA01B93ACC9521BDAA76277B922D82EF90EBA2B3C",
  signer: "GOOGLE_LLC_VERIFIED",
};

test("bootstrap environment retains the authenticated ordinary-user profile and fills only missing user proxies", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-supervisor-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "bootstrap-env.json"), JSON.stringify({
    LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
    APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\Alice",
    HTTP_PROXY: "http://bootstrap.proxy:7897",
  }));
  const environment = await loadBootstrapEnvironment({
    stateDir: root,
    bootstrapEnvPath: path.join(root, "bootstrap-env.json"),
  }, {
    proxyResolver: async () => ({
      HTTP_PROXY: "http://registry.proxy:7897",
      HTTPS_PROXY: "http://registry.proxy:7897",
    }),
  });
  assert.equal(environment.LOCALAPPDATA, "C:\\Users\\Alice\\AppData\\Local");
  assert.equal(environment.APPDATA, "C:\\Users\\Alice\\AppData\\Roaming");
  assert.equal(environment.USERPROFILE, "C:\\Users\\Alice");
  assert.equal(environment.HOME, "C:\\Users\\Alice");
  assert.equal(environment.HTTP_PROXY, "http://bootstrap.proxy:7897");
  assert.equal(environment.HTTPS_PROXY, "http://registry.proxy:7897");
});

class FakeSessionProcess {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.pid = 4242 + FakeSessionProcess.instances.length;
    this.runtimeState = "new";
    this.conversationId = options.conversationId || "conversation-1";
    this.prompts = [];
    FakeSessionProcess.instances.push(this);
  }

  async start() {
    this.runtimeState = "ready";
    return {
      conversationId: this.conversationId,
      model: this.options.model,
      permissionMode: "always-proceed",
      effortStatus: "ACCEPTED_NOT_ATTESTED",
    };
  }

  async sendTurn(prompt, { captureFullResponse = false } = {}) {
    this.runtimeState = "turn_active";
    this.prompts.push(prompt);
    this.runtimeState = "ready";
    const fullResponse = `reply-${this.prompts.length}`;
    return {
      status: "SUCCESS",
      response: fullResponse,
      responseTruncated: false,
      responseBytes: Buffer.byteLength(fullResponse, "utf8"),
      responseSha256: createHash("sha256").update(fullResponse, "utf8").digest("hex"),
      ...(captureFullResponse ? { fullResponse } : {}),
      metadata: {
        conversationId: this.conversationId,
        model: this.options.model,
        effort: this.options.effort,
        permissionMode: "always-proceed",
        effortStatus: "ACCEPTED_NOT_ATTESTED",
      },
    };
  }

  async cancelCurrentTurn() {
    return { status: "no_active_turn", remoteStatus: "remote_unknown" };
  }

  async close() {
    this.runtimeState = "closed";
    return { status: "closed", remoteStatus: "exited" };
  }
}

class LongResultProcess extends FakeSessionProcess {
  async sendTurn(prompt, { captureFullResponse = false } = {}) {
    this.runtimeState = "turn_active";
    this.prompts.push(prompt);
    this.runtimeState = "ready";
    const fullResponse = "界".repeat(9001);
    return {
      status: "SUCCESS",
      response: `${fullResponse.slice(0, 8000)}…`,
      responseTruncated: true,
      responseBytes: Buffer.byteLength(fullResponse, "utf8"),
      responseSha256: createHash("sha256").update(fullResponse, "utf8").digest("hex"),
      ...(captureFullResponse ? { fullResponse } : {}),
      metadata: {
        conversationId: this.conversationId,
        model: this.options.model,
        effort: this.options.effort,
        permissionMode: "always-proceed",
        effortStatus: "ACCEPTED_NOT_ATTESTED",
      },
    };
  }
}

class FailingSecondTurnProcess extends FakeSessionProcess {
  async sendTurn(prompt) {
    if (this.prompts.length === 1) {
      this.prompts.push(prompt);
      const error = new Error("PROCESS_EXITED");
      error.code = "PROCESS_EXITED";
      throw error;
    }
    return super.sendTurn(prompt);
  }
}

class PermissionSecondTurnProcess extends FakeSessionProcess {
  async sendTurn(prompt) {
    if (this.prompts.length === 1) {
      this.prompts.push(prompt);
      this.options.onActivity({ type: "permission_denied", permissionDenied: true });
      const error = new Error("TOOL_FAILURE");
      error.code = "TOOL_FAILURE";
      throw error;
    }
    return super.sendTurn(prompt);
  }
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-supervisor-controller-"));
  const workspace = path.join(root, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  t.after(() => rm(root, { recursive: true, force: true }));
  FakeSessionProcess.instances = [];
  const statePath = path.join(root, "state.json");
  const controller = await new AgySupervisorController({
    paths: { stateDir: root },
    statePath,
    verifier: { verify: async () => runtime },
    SessionProcess: FakeSessionProcess,
    agyPath: path.join(root, "agy.exe"),
    runtimePreparer: async ({ sourcePath, verifier }) => ({
      ...(await verifier.verify({ agyPath: sourcePath })),
      managedRuntimePath: sourcePath,
      executionPath: sourcePath,
    }),
    ...overrides,
  }).initialize("epoch-test");
  return { root, workspace, statePath, controller };
}

async function terminal(controller, runId) {
  let afterRevision = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const view = await controller.inspect({ runId, afterRevision, waitMs: 250 });
    if (["completed", "failed", "needs_attention", "cancelled_before_send"].includes(view.run.status)) return view;
    afterRevision = view.revision;
  }
  assert.fail("run did not become terminal");
}

test("new and resumed turns reuse one persistent process without persisting content", async (t) => {
  const { workspace, statePath, controller } = await fixture(t);
  const first = await controller.startTurn({
    mode: "new",
    cwd: workspace,
    prompt: "private first prompt",
    requestId: "request-1",
    model: "gemini-3.8-flash",
    effort: "high",
    confirmation: "SEND_TO_AGY",
  });
  assert.equal(first.session.permissionMode, null);
  const firstDone = await terminal(controller, first.run.runId);
  assert.equal(firstDone.run.status, "completed");
  assert.equal(firstDone.run.result, "reply-1");
  assert.equal(firstDone.session.conversationId, "conversation-1");
  assert.equal(firstDone.session.permissionMode, "always-proceed");

  const second = await controller.startTurn({
    mode: "resume",
    sessionId: first.session.sessionId,
    cwd: workspace,
    prompt: "private second prompt",
    requestId: "request-2",
    confirmation: "SEND_TO_AGY",
  });
  const secondDone = await terminal(controller, second.run.runId);
  assert.equal(secondDone.run.status, "completed");
  assert.equal(secondDone.run.result, "reply-2");
  assert.equal(FakeSessionProcess.instances.length, 1);
  assert.deepEqual(FakeSessionProcess.instances[0].prompts, ["private first prompt", "private second prompt"]);

  const durable = await readFile(statePath, "utf8");
  assert.equal(durable.includes("private first prompt"), false);
  assert.equal(durable.includes("private second prompt"), false);
  assert.equal(durable.includes("reply-1"), false);
  assert.equal(durable.includes("reply-2"), false);
});

test("complete result artifacts are opt-in, exact, and durable across a daemon restart", async (t) => {
  const { root, workspace, statePath, controller } = await fixture(t, { SessionProcess: LongResultProcess });
  const fullResponse = "界".repeat(9001);
  const inline = `${fullResponse.slice(0, 8000)}…`;

  const defaultStarted = await controller.startTurn({
    mode: "new",
    cwd: workspace,
    prompt: "keep the default memory-only response",
    confirmation: "SEND_TO_AGY",
  });
  const defaultDone = await terminal(controller, defaultStarted.run.runId);
  assert.equal(defaultDone.run.result, inline);
  assert.equal(defaultDone.run.resultTruncated, true);
  assert.equal(defaultDone.run.resultArtifact, null);
  assert.equal((await readFile(statePath, "utf8")).includes(fullResponse), false);

  const savedStarted = await controller.startTurn({
    mode: "resume",
    sessionId: defaultStarted.session.sessionId,
    cwd: workspace,
    prompt: "save the complete final reply",
    saveResultArtifact: true,
    confirmation: "SEND_TO_AGY",
  });
  const savedDone = await terminal(controller, savedStarted.run.runId);
  const artifact = savedDone.run.resultArtifact;
  assert.equal(savedDone.run.result, inline);
  assert.equal(savedDone.run.resultTruncated, true);
  assert.equal(savedDone.run.resultBytes, Buffer.byteLength(inline, "utf8"));
  assert.equal(savedDone.run.resultSha256, createHash("sha256").update(inline, "utf8").digest("hex"));
  assert.deepEqual(artifact, {
    requested: true,
    status: "available",
    path: artifact.path,
    bytes: Buffer.byteLength(fullResponse, "utf8"),
    sha256: createHash("sha256").update(fullResponse, "utf8").digest("hex"),
    errorKind: null,
  });
  assert.notEqual(savedDone.run.resultBytes, artifact.bytes);
  assert.notEqual(savedDone.run.resultSha256, artifact.sha256);
  assert.equal(path.dirname(artifact.path), path.join(root, "results"));
  assert.equal(await readFile(artifact.path, "utf8"), fullResponse);

  const restarted = await new AgySupervisorController({
    paths: { stateDir: root },
    statePath,
  }).initialize("epoch-restarted");
  const recovered = await restarted.inspect({ runId: savedStarted.run.runId });
  assert.equal(recovered.run.resultAvailable, false);
  assert.equal(Object.hasOwn(recovered.run, "result"), false);
  assert.deepEqual(recovered.run.resultArtifact, artifact);
  assert.equal(recovered.session.lastRunId, savedStarted.run.runId);
  assert.equal(await readFile(recovered.run.resultArtifact.path, "utf8"), fullResponse);
});

test("artifact write failures remain explicit while the bounded inline result stays available", async (t) => {
  const { root, workspace, controller } = await fixture(t, { SessionProcess: LongResultProcess });
  const blockedStateRoot = path.join(root, "not-a-directory");
  await writeFile(blockedStateRoot, "blocked", "utf8");
  controller.paths = { stateDir: blockedStateRoot };

  const started = await controller.startTurn({
    mode: "new",
    cwd: workspace,
    prompt: "report the artifact failure without losing the inline result",
    saveResultArtifact: true,
    confirmation: "SEND_TO_AGY",
  });
  const done = await terminal(controller, started.run.runId);
  assert.equal(done.run.status, "completed");
  assert.equal(done.run.resultAvailable, true);
  assert.equal(done.run.resultTruncated, true);
  assert.deepEqual(done.run.resultArtifact, {
    requested: true,
    status: "failed",
    path: null,
    bytes: null,
    sha256: null,
    errorKind: "RESULT_ARTIFACT_WRITE_FAILED",
  });
});

test("inspect pages newest sessions with bounded run metadata and validates cursors", async (t) => {
  const { workspace, controller } = await fixture(t);
  await controller._update((state) => {
    for (let index = 0; index < 23; index += 1) {
      const sessionId = `agy-${String(index).padStart(2, "0")}`;
      const runId = `run-${String(index).padStart(2, "0")}`;
      const updatedAt = `2026-09-04T00:00:${String(index).padStart(2, "0")}.000Z`;
      state.sessions[sessionId] = {
        sessionId,
        cwd: workspace,
        workspaceHash: "a".repeat(64),
        model: "gemini-3.8-flash",
        effort: "high",
        effortStatus: "ACCEPTED_NOT_ATTESTED",
        permissionMode: "always-proceed",
        status: "idle",
        createdAt: updatedAt,
        updatedAt,
      };
      state.runs[runId] = {
        runId,
        sessionId,
        requestId: `request-${index}`,
        workspaceHash: "a".repeat(64),
        requestSha256: "b".repeat(64),
        requestBytes: 1,
        status: "completed",
        phase: "terminal",
        resultStatus: "SUCCESS",
        remoteStatus: "terminal",
        startedAt: updatedAt,
        updatedAt,
      };
    }
  });

  const first = await controller.inspect({});
  assert.equal(first.sessions.length, 20);
  assert.equal(first.sessions[0].sessionId, "agy-22");
  assert.equal(first.sessions[19].sessionId, "agy-03");
  assert.equal(first.omittedSessions, 3);
  assert.equal(first.nextCursor, "agy-03");
  assert.equal(first.sessions[0].lastRunId, "run-22");
  assert.deepEqual(first.sessions[0].recentRuns.map((run) => run.runId), ["run-22"]);
  assert.equal(Object.hasOwn(first.sessions[0].recentRuns[0], "result"), false);
  assert.equal(Object.hasOwn(first.sessions[0].recentRuns[0], "resultAvailable"), false);

  const second = await controller.inspect({ cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.sessions.map((session) => session.sessionId), ["agy-02", "agy-01"]);
  assert.equal(second.omittedSessions, 1);
  assert.equal(second.nextCursor, "agy-01");
  const third = await controller.inspect({ cursor: second.nextCursor, limit: 2 });
  assert.deepEqual(third.sessions.map((session) => session.sessionId), ["agy-00"]);
  assert.equal(third.omittedSessions, 0);
  assert.equal(third.nextCursor, null);

  await assert.rejects(controller.inspect({ cursor: "missing" }), { kind: "INVALID_CURSOR" });
  await assert.rejects(controller.inspect({ limit: 0 }), { kind: "INVALID_SESSION_LIMIT" });
  await assert.rejects(controller.inspect({ limit: 101 }), { kind: "INVALID_SESSION_LIMIT" });
  await assert.rejects(controller.inspect({ sessionId: "agy-22", limit: 2 }), { kind: "PAGINATION_NOT_ALLOWED" });
});

test("history compaction does not delete an explicitly delivered result artifact", async (t) => {
  const { root, workspace, controller } = await fixture(t);
  const runId = "run-000";
  const artifactPath = path.join(root, "results", `${createHash("sha256").update(runId, "utf8").digest("hex")}.txt`);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, "delivered final reply", "utf8");

  await controller._update((state) => {
    state.sessions["agy-closed"] = {
      sessionId: "agy-closed",
      cwd: workspace,
      workspaceHash: "a".repeat(64),
      model: "gemini-3.8-flash",
      effort: "high",
      status: "closed",
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    };
    for (let index = 0; index < 501; index += 1) {
      const id = `run-${String(index).padStart(3, "0")}`;
      state.runs[id] = {
        runId: id,
        sessionId: "agy-closed",
        requestId: `request-${index}`,
        intentSha256: "b".repeat(64),
        workspaceHash: "a".repeat(64),
        requestSha256: "c".repeat(64),
        requestBytes: 1,
        status: "completed",
        phase: "terminal",
        resultStatus: "SUCCESS",
        remoteStatus: "terminal",
        startedAt: index === 0 ? "2026-09-02T00:00:00.000Z" : "2026-09-03T00:00:00.000Z",
        updatedAt: index === 0 ? "2026-09-02T00:00:00.000Z" : "2026-09-03T00:00:00.000Z",
      };
    }
    state.runs[runId].saveResultArtifact = true;
    state.runs[runId].resultArtifactStatus = "available";
    state.runs[runId].resultArtifactPath = artifactPath;
    state.runs[runId].resultArtifactBytes = Buffer.byteLength("delivered final reply", "utf8");
    state.runs[runId].resultArtifactSha256 = createHash("sha256").update("delivered final reply", "utf8").digest("hex");
  });

  const state = await controller.store.snapshot();
  assert.equal(Object.hasOwn(state.runs, runId), false);
  assert.equal(await readFile(artifactPath, "utf8"), "delivered final reply");
});

test("a long-lived daemon refreshes the user proxy environment before creating a fresh AGY process", async (t) => {
  const startupEnvironment = {
    USERPROFILE: "C:\\Users\\Old",
    HOME: "C:\\Users\\Old",
    HTTP_PROXY: "http://old.proxy:7897",
    HTTPS_PROXY: "http://old.proxy:7897",
  };
  let currentEnvironment = startupEnvironment;
  const { workspace, controller } = await fixture(t, {
    agyEnvironment: startupEnvironment,
    environmentLoader: async () => currentEnvironment,
  });
  currentEnvironment = {
    USERPROFILE: "C:\\Users\\Alice",
    HOME: "C:\\Users\\Alice",
    HTTP_PROXY: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://127.0.0.1:7897",
  };

  const started = await controller.startTurn({
    mode: "new",
    cwd: workspace,
    prompt: "use the refreshed environment",
    confirmation: "SEND_TO_AGY",
  });
  const done = await terminal(controller, started.run.runId);

  assert.equal(done.run.status, "completed");
  assert.equal(FakeSessionProcess.instances.length, 1);
  assert.equal(FakeSessionProcess.instances[0].options.env.USERPROFILE, "C:\\Users\\Alice");
  assert.equal(FakeSessionProcess.instances[0].options.env.HOME, "C:\\Users\\Alice");
  assert.equal(FakeSessionProcess.instances[0].options.env.HTTP_PROXY, "http://127.0.0.1:7897");
  assert.equal(FakeSessionProcess.instances[0].options.env.HTTPS_PROXY, "http://127.0.0.1:7897");
});

test("request IDs are idempotent and conflicting content fails closed", async (t) => {
  const { workspace, controller } = await fixture(t);
  const first = await controller.startTurn({
    mode: "new",
    cwd: workspace,
    prompt: "same",
    requestId: "request-stable",
    confirmation: "SEND_TO_AGY",
  });
  await terminal(controller, first.run.runId);
  const stored = (await controller.store.snapshot()).runs[first.run.runId];
  const request = hashPrompt("same");
  const legacyIntentSha256 = createHash("sha256").update(JSON.stringify({
    mode: "new",
    sessionId: null,
    workspaceHash: stored.workspaceHash,
    requestSha256: request.sha256,
    requestBytes: request.bytes,
    model: "gemini-3.8-flash",
    effort: "high",
  }), "utf8").digest("hex");
  assert.equal(stored.intentSha256, legacyIntentSha256);
  const replay = await controller.startTurn({
    mode: "new",
    cwd: workspace,
    prompt: "same",
    requestId: "request-stable",
    confirmation: "SEND_TO_AGY",
  });
  assert.equal(replay.reused, true);
  assert.equal(replay.run.runId, first.run.runId);
  await assert.rejects(
    controller.startTurn({
      mode: "new",
      cwd: workspace,
      prompt: "different",
      requestId: "request-stable",
      confirmation: "SEND_TO_AGY",
    }),
    { kind: "REQUEST_ID_CONFLICT" },
  );
  await assert.rejects(
    controller.startTurn({
      mode: "new",
      cwd: workspace,
      prompt: "same",
      requestId: "request-stable",
      model: "different-model",
      confirmation: "SEND_TO_AGY",
    }),
    { kind: "REQUEST_ID_CONFLICT" },
  );
  await assert.rejects(
    controller.startTurn({
      mode: "new",
      cwd: workspace,
      prompt: "same",
      requestId: "request-stable",
      saveResultArtifact: true,
      confirmation: "SEND_TO_AGY",
    }),
    { kind: "REQUEST_ID_CONFLICT" },
  );
});

test("a failure after send stays uncertain and blocks every later writer", async (t) => {
  const { workspace, controller } = await fixture(t, {
    SessionProcess: FailingSecondTurnProcess,
    processProbe: async () => ({ alive: false, fingerprint: null }),
  });
  const first = await controller.startTurn({
    mode: "new",
    cwd: workspace,
    prompt: "first",
    confirmation: "SEND_TO_AGY",
  });
  await terminal(controller, first.run.runId);
  const second = await controller.startTurn({
    mode: "resume",
    sessionId: first.session.sessionId,
    cwd: workspace,
    prompt: "may have executed",
    confirmation: "SEND_TO_AGY",
  });
  const uncertain = await terminal(controller, second.run.runId);
  assert.equal(uncertain.run.status, "needs_attention");
  assert.equal(uncertain.run.errorKind, "TURN_OUTCOME_UNKNOWN");
  assert.equal(uncertain.run.remoteStatus, "exited_without_terminal");
  await assert.rejects(
    controller.startTurn({
      mode: "resume",
      sessionId: first.session.sessionId,
      cwd: workspace,
      prompt: "must wait for acknowledgement",
      confirmation: "SEND_TO_AGY",
    }),
    { kind: "UNCERTAIN_RUN_ACK_REQUIRED" },
  );
  await assert.rejects(
    controller.startTurn({
      mode: "new",
      cwd: workspace,
      prompt: "cannot bypass with a new session",
      confirmation: "SEND_TO_AGY",
    }),
    { kind: "WORKSPACE_BUSY" },
  );
});

test("reused process activity is attributed to the current run", async (t) => {
  const { workspace, controller } = await fixture(t, { SessionProcess: PermissionSecondTurnProcess });
  const first = await controller.startTurn({
    mode: "new",
    cwd: workspace,
    prompt: "first",
    confirmation: "SEND_TO_AGY",
  });
  await terminal(controller, first.run.runId);
  const second = await controller.startTurn({
    mode: "resume",
    sessionId: first.session.sessionId,
    cwd: workspace,
    prompt: "permission failure",
    confirmation: "SEND_TO_AGY",
  });
  const failed = await terminal(controller, second.run.runId);
  assert.equal(failed.run.status, "failed");
  assert.equal(failed.run.permissionDeniedSeen, true);
  assert.equal(failed.run.toolFailureSeen, true);
});

test("recovered active work requires explicit uncertainty acknowledgement", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-supervisor-recovery-"));
  const workspace = path.join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = await import("node:fs/promises").then(({ realpath }) => realpath(workspace));
  const workspaceHash = createHash("sha256").update(canonicalWorkspace(cwd), "utf8").digest("hex");
  const statePath = path.join(root, "state.json");
  await writeFile(statePath, `${JSON.stringify({
    schemaVersion: 1,
    revision: 4,
    epochId: "old-epoch",
    updatedAt: "2026-09-03T00:00:00.000Z",
    sessions: {
      "agy-session": {
        sessionId: "agy-session",
        cwd,
        workspaceHash,
        model: "gemini-3.8-flash",
        effort: "high",
        effortStatus: "ACCEPTED_NOT_ATTESTED",
        permissionMode: "always-proceed",
        conversationId: "conversation-1",
        status: "running",
        activeRunId: "run-active",
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z"
      }
    },
    runs: {
      "run-active": {
        runId: "run-active",
        sessionId: "agy-session",
        requestId: "request-active",
        workspaceHash,
        requestSha256: "a".repeat(64),
        requestBytes: 8,
        status: "running",
        phase: "turn_active",
        remoteStatus: "active",
        childPid: 424242,
        processFingerprint: "f".repeat(64),
        startedAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z"
      }
    },
    reservations: { [workspaceHash]: { runId: "run-active", sessionId: "agy-session" } }
  })}\n`, "utf8");

  let orphanAlive = true;
  const controller = await new AgySupervisorController({
    statePath,
    verifier: { verify: async () => runtime },
    SessionProcess: FakeSessionProcess,
    agyPath: path.join(root, "agy.exe"),
    processProbe: async () => orphanAlive
      ? { alive: true, fingerprint: "f".repeat(64) }
      : { alive: false, fingerprint: null },
  }).initialize("new-epoch");
  const recovered = await controller.inspect({ sessionId: "agy-session", runId: "run-active" });
  assert.equal(recovered.session.status, "unknown_after_restart");
  assert.equal(recovered.run.status, "unknown_after_restart");
  await assert.rejects(
    controller.startTurn({
      mode: "resume",
      sessionId: "agy-session",
      cwd,
      prompt: "do not replay",
      confirmation: "SEND_TO_AGY",
    }),
    { kind: "UNCERTAIN_RUN_ACK_REQUIRED" },
  );
  await assert.rejects(
    controller.control({
      action: "acknowledge_uncertain",
      sessionId: "agy-session",
      runId: "run-active",
      confirmation: "CONTROL_AGY_SESSION",
    }),
    { kind: "ORPHAN_PROCESS_STILL_RUNNING" },
  );
  orphanAlive = false;
  const acknowledged = await controller.control({
    action: "acknowledge_uncertain",
    sessionId: "agy-session",
    runId: "run-active",
    confirmation: "CONTROL_AGY_SESSION",
  });
  assert.equal(acknowledged.run.status, "acknowledged_uncertain");
  assert.equal(acknowledged.session.status, "idle");
});

test("terminal history compacts before the state object reaches its hard key limit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-supervisor-history-"));
  const workspace = path.join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, "state.json");
  const runs = {};
  for (let index = 0; index < 502; index += 1) {
    const runId = `run-${String(index).padStart(4, "0")}`;
    runs[runId] = {
      runId,
      sessionId: "agy-closed",
      requestId: `request-${index}`,
      intentSha256: "a".repeat(64),
      workspaceHash: "b".repeat(64),
      requestSha256: "c".repeat(64),
      requestBytes: 1,
      status: "completed",
      phase: "terminal",
      resultStatus: "SUCCESS",
      remoteStatus: "terminal",
      startedAt: `2026-09-03T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      updatedAt: `2026-09-03T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    };
  }
  await writeFile(statePath, `${JSON.stringify({
    schemaVersion: 1,
    sessions: {
      "agy-closed": {
        sessionId: "agy-closed",
        cwd: workspace,
        workspaceHash: "b".repeat(64),
        model: "gemini-3.8-flash",
        effort: "high",
        effortStatus: "ACCEPTED_NOT_ATTESTED",
        permissionMode: "always-proceed",
        conversationId: "conversation-1",
        status: "closed",
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z"
      }
    },
    runs,
    reservations: {},
    requestTombstones: {}
  })}\n`, "utf8");
  const controller = await new AgySupervisorController({ statePath }).initialize("history-epoch");
  const durable = await controller.store.snapshot();
  assert.equal(Object.keys(durable.runs).length, 500);
  assert.equal(Object.keys(durable.requestTombstones).length, 2);
});
