import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgySupervisorController, loadBootstrapEnvironment } from "./supervisor-daemon.mjs";
import { canonicalWorkspace } from "./state-store.mjs";
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

  async sendTurn(prompt) {
    this.runtimeState = "turn_active";
    this.prompts.push(prompt);
    this.runtimeState = "ready";
    return {
      status: "SUCCESS",
      response: `reply-${this.prompts.length}`,
      responseTruncated: false,
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
