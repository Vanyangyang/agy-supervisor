import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGY_EFFORT_STATUS,
  AGY_MODEL_ATTESTATION_TIMING,
  AgySessionProcess,
} from "./agy-runner.mjs";

const FAKE_CLI_SOURCE = String.raw`
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [scenario, auditPath, ...args] = process.argv.slice(2);
const argument = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
};
const model = argument("--model");
const suppliedConversation = argument("--conversation");
const conversationId = suppliedConversation || "conversation-1";
const audit = { args, lines: [] };
const saveAudit = () => writeFileSync(auditPath, JSON.stringify(audit), "utf8");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
saveAudit();

if (scenario === "malformed") {
  process.stdout.write("{not-json}\n");
} else if (scenario === "auth-no-init") {
  process.stderr.write("Please sign in in an interactive terminal\n");
} else if (scenario !== "no-init") {
  setImmediate(() => emit({
    event: "init",
    conversation_id: conversationId,
    init: {
      cwd: scenario === "cwd-mismatch" ? process.cwd() + "-wrong" : process.cwd(),
      tools: [],
      model: scenario === "model-mismatch" ? "other-model" : model,
      permission_mode: scenario === "permission-mismatch" ? "request-review" : "always-proceed",
    },
  }));
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let turns = 0;
input.on("line", (line) => {
  try {
    audit.lines.push(JSON.parse(line));
    saveAudit();
  } catch {
    process.exitCode = 2;
    return;
  }
  turns += 1;
  if (scenario === "never-result") return;
  if (scenario === "cancel-race") {
    setTimeout(() => emit({ event: "result", result: { status: "SUCCESS", conversation_id: conversationId, response: "finished" } }), 30);
    return;
  }
  if (scenario === "conversation-mismatch") {
    emit({ event: "result", result: { status: "SUCCESS", conversation_id: "other-conversation", response: "ignored" } });
    return;
  }
  if (scenario === "tool-failure") {
    emit({ event: "step_update", step_update: { step_type: "tool", tool_info: { error: "blocked" } } });
  }
  if (scenario === "always-proceed-tool-label") {
    emit({ event: "step_update", step_update: { step_type: "tool", tool_info: { status: "success", permission_mode: "always-proceed" } } });
  }
  const response = scenario === "large-response" ? "界".repeat(6000)
    : scenario === "long-response" ? "界".repeat(9001)
      : "reply-" + turns;
  emit({ event: "result", result: { status: "SUCCESS", conversation_id: conversationId, response } });
  if (scenario === "result-and-exit") process.exit(0);
});
input.on("close", () => setTimeout(() => process.exit(0), 20));
`;

function waitUntil(predicate, timeoutMs = 1_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) return resolvePromise();
      if (Date.now() >= deadline) return rejectPromise(new Error("timed out waiting for fake CLI"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function createFakeSession(t, scenario, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "agy-runner-test-"));
  const script = join(root, "fake-agy.mjs");
  const auditPath = join(root, "audit.json");
  const isolatedProfile = join(root, "agy-profile");
  writeFileSync(script, FAKE_CLI_SOURCE, "utf8");
  const observed = { command: null, args: null, options: null, child: null };
  const spawnImpl = (command, args, options) => {
    observed.command = command;
    observed.args = [...args];
    observed.options = options;
    observed.child = nodeSpawn(process.execPath, [script, scenario, auditPath, ...args], options);
    return observed.child;
  };
  const session = new AgySessionProcess({
    agyPath: join(root, "agy.exe"),
    cwd: root,
    env: {
      ...process.env,
      USERPROFILE: isolatedProfile,
      HOME: isolatedProfile,
      API_KEY: "must-not-reach-child",
      ACCESS_TOKEN: "must-not-reach-child",
    },
    spawnImpl,
    initTimeoutMs: 1_500,
    closeTimeoutMs: 1_500,
    ...overrides,
  });
  t.after(async () => {
    await session.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { auditPath, observed, session };
}

test("runner gates on init and sends two NDJSON turns through one conversation", async (t) => {
  const { auditPath, observed, session } = createFakeSession(t, "normal", {
    conversationId: "conversation-1",
    maxEvents: 1,
  });
  const init = await session.start();
  const first = await session.sendTurn("first prompt stays on stdin");
  const second = await session.sendTurn("second prompt stays on stdin");
  await waitUntil(() => JSON.parse(readFileSync(auditPath, "utf8")).lines.length === 2);
  const audit = JSON.parse(readFileSync(auditPath, "utf8"));

  assert.equal(session.conversationId, "conversation-1");
  assert.equal(init.model, "gemini-3.8-flash");
  assert.equal(init.permissionMode, "always-proceed");
  assert.equal(init.effortStatus, AGY_EFFORT_STATUS);
  assert.equal(init.modelAttestationTiming, AGY_MODEL_ATTESTATION_TIMING);
  assert.deepEqual(observed.args, [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--model", "gemini-3.8-flash",
    "--effort", "high",
    "--sandbox",
    "--dangerously-skip-permissions",
    "--conversation", "conversation-1",
  ]);
  assert.equal(JSON.stringify(observed.args).includes("first prompt"), false);
  assert.equal(JSON.stringify(observed.args).includes("second prompt"), false);
  assert.deepEqual(audit.lines, [
    { event: "user", message: { content: "first prompt stays on stdin" } },
    { event: "user", message: { content: "second prompt stays on stdin" } },
  ]);
  assert.equal(observed.options.windowsHide, true);
  assert.deepEqual(observed.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.env.USERPROFILE, observed.options.env.HOME);
  assert.match(observed.options.env.HOME, /agy-profile$/u);
  assert.equal("API_KEY" in observed.options.env, false);
  assert.equal("ACCESS_TOKEN" in observed.options.env, false);
  assert.equal(first.response, "reply-1");
  assert.equal(second.response, "reply-2");
  assert.equal(first.metadata.conversationId, second.metadata.conversationId);
  assert.equal(first.metadata.effortStatus, "ACCEPTED_NOT_ATTESTED");
  assert.equal((await session.close()).status, "closed");
});

test("default NDJSON line budget accepts a bounded multi-byte response", async (t) => {
  const { session } = createFakeSession(t, "large-response");
  await session.start();
  const result = await session.sendTurn("return a bounded response");
  assert.equal(result.response, "界".repeat(6000));
  assert.equal(result.responseTruncated, false);
  assert.equal(Object.hasOwn(result, "fullResponse"), false);
});

test("opt-in full response capture preserves the terminal reply before inline truncation", async (t) => {
  const { session } = createFakeSession(t, "long-response");
  const fullResponse = "界".repeat(9001);
  await session.start();
  const result = await session.sendTurn("capture the complete final reply", { captureFullResponse: true });

  assert.equal(result.response, `${fullResponse.slice(0, 8000)}…`);
  assert.equal(result.responseTruncated, true);
  assert.equal(result.fullResponse, fullResponse);
});

test("a valid terminal result remains authoritative when the child exits immediately after it", async (t) => {
  const { session } = createFakeSession(t, "result-and-exit");
  await session.start();
  const result = await session.sendTurn("return then exit");
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.response, "reply-1");
});

test("always-proceed tool metadata is not misclassified as a permission denial", async (t) => {
  const { session } = createFakeSession(t, "always-proceed-tool-label");
  const result = await session.sendTurn("accept the explicit permission label");
  assert.equal(result.status, "SUCCESS");
});

test("runner rejects a result from any conversation other than the initialized one", async (t) => {
  const { session } = createFakeSession(t, "conversation-mismatch");
  await session.start();
  await assert.rejects(session.sendTurn("do not accept a crossed conversation"), (error) => error.code === "CONVERSATION_MISMATCH");
  assert.equal(session.runtimeState, "failed");
});

test("runner fails closed before any prompt when init model is wrong", async (t) => {
  const { auditPath, session } = createFakeSession(t, "model-mismatch");
  await assert.rejects(session.start(), (error) => error.code === "INIT_MODEL_MISMATCH");
  const audit = JSON.parse(readFileSync(auditPath, "utf8"));
  assert.deepEqual(audit.lines, []);
});

test("runner rejects any permission mode other than the explicit always-proceed contract before a prompt", async (t) => {
  const { session } = createFakeSession(t, "permission-mismatch");
  await assert.rejects(session.start(), (error) => error.code === "INIT_PERMISSION_MISMATCH");
});

test("runner times out rather than writing a prompt without an init event", async (t) => {
  const { auditPath, session } = createFakeSession(t, "no-init", { initTimeoutMs: 150 });
  await assert.rejects(session.start(), (error) => error.code === "INIT_TIMEOUT");
  const audit = JSON.parse(readFileSync(auditPath, "utf8"));
  assert.deepEqual(audit.lines, []);
});

test("runner reports auth-like startup stderr without writing a prompt", async (t) => {
  const { auditPath, session } = createFakeSession(t, "auth-no-init", { initTimeoutMs: 150 });
  await assert.rejects(session.start(), (error) => error.code === "AUTH_REQUIRED_IN_USER_TERMINAL");
  const audit = JSON.parse(readFileSync(auditPath, "utf8"));
  assert.deepEqual(audit.lines, []);
});

test("tool failures cannot be reported as a completed turn", async (t) => {
  const { session } = createFakeSession(t, "tool-failure");
  await session.start();
  await assert.rejects(session.sendTurn("a tool failure must remain a failure"), (error) => error.code === "TOOL_FAILURE");
  assert.equal(session.runtimeState, "ready");
});

test("cancellation targets only this session child and remains remote-unknown until exit", async (t) => {
  const { auditPath, observed, session } = createFakeSession(t, "never-result");
  await session.start();
  let foreignKillCalls = 0;
  const foreignChild = { kill: () => { foreignKillCalls += 1; } };
  let ownedKillCalls = 0;
  const ownedKill = observed.child.kill.bind(observed.child);
  observed.child.kill = (...args) => {
    ownedKillCalls += 1;
    return ownedKill(...args);
  };
  const pending = session.sendTurn("cancel this exact child");
  await waitUntil(() => JSON.parse(readFileSync(auditPath, "utf8")).lines.length === 1);
  const cancellation = await session.cancelCurrentTurn();

  assert.deepEqual(cancellation, { status: "cancel_requested", remoteStatus: "remote_unknown", killAccepted: true });
  assert.equal(ownedKillCalls, 1);
  assert.equal(foreignKillCalls, 0);
  assert.equal(typeof foreignChild.kill, "function");
  await assert.rejects(pending, (error) => error.code === "TURN_CANCELLED");
});

test("a terminal result racing with cancellation settles with known success", async (t) => {
  const { auditPath, observed, session } = createFakeSession(t, "cancel-race");
  await session.start();
  observed.child.kill = () => true;
  const pending = session.sendTurn("finish even if cancellation races");
  await waitUntil(() => JSON.parse(readFileSync(auditPath, "utf8")).lines.length === 1);
  await session.cancelCurrentTurn();
  const result = await pending;
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.metadata.cancelRequested, true);
});

test("a failed cancellation signal settles on a bounded deadline", async (t) => {
  const { auditPath, observed, session } = createFakeSession(t, "never-result", { cancelTimeoutMs: 100 });
  await session.start();
  observed.child.kill = () => false;
  const pending = session.sendTurn("do not hang the reservation");
  await waitUntil(() => JSON.parse(readFileSync(auditPath, "utf8")).lines.length === 1);
  const cancellation = await session.cancelCurrentTurn();
  assert.equal(cancellation.killAccepted, false);
  await assert.rejects(pending, (error) => error.code === "CANCEL_TIMEOUT");
});

test("malformed NDJSON fails closed during startup", async (t) => {
  const { session } = createFakeSession(t, "malformed");
  await assert.rejects(session.start(), (error) => error.code === "MALFORMED_NDJSON");
});
