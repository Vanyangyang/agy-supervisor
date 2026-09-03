import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  buildHandoffPayload,
  containsForbiddenFields,
  createPanelServer,
  isAllowedHost,
  publicLifecycle,
  readPanelState,
  renderPanelPage,
  sanitizeRun,
  sanitizeSession,
} from "./panel.mjs";

class FakeClient {
  constructor({ online = true, inspectResult = null } = {}) {
    this.online = online;
    this.inspectResult = inspectResult;
  }
  async ping() {
    if (!this.online) {
      const error = new Error("unavailable");
      error.kind = "unavailable";
      throw error;
    }
    return { ready: true, protocolVersion: 1, runtimeVersion: "0.3.0" };
  }
  async inspect() {
    if (!this.online) {
      const error = new Error("unavailable");
      error.kind = "unavailable";
      throw error;
    }
    return this.inspectResult;
  }
}

const runningInspect = {
  revision: 7,
  epochId: "epoch-1",
  daemon: { protocolVersion: 1, runtimeVersion: "0.3.0" },
  sessions: [{
    sessionId: "agy-1",
    conversationId: "conv-1",
    cwd: "C:\\work\\demo",
    model: "gemini-3.8-flash",
    effort: "high",
    effortStatus: "ACCEPTED_NOT_ATTESTED",
    permissionMode: "always-proceed",
    status: "running",
    activeRunId: "run-1",
    runtimeVersion: "1.1.25",
    runtimeSha256: "ABC",
    runtimeSignatureStatus: "GOOGLE_LLC_VERIFIED",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:01.000Z",
  }],
  session: {
    sessionId: "agy-1",
    conversationId: "conv-1",
    cwd: "C:\\work\\demo",
    model: "gemini-3.8-flash",
    effort: "high",
    effortStatus: "ACCEPTED_NOT_ATTESTED",
    permissionMode: "always-proceed",
    status: "running",
    activeRunId: "run-1",
    runtimeVersion: "1.1.25",
    runtimeSha256: "ABC",
    runtimeSignatureStatus: "GOOGLE_LLC_VERIFIED",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:01.000Z",
  },
  run: {
    runId: "run-1",
    sessionId: "agy-1",
    requestId: "req-1",
    status: "running",
    phase: "turn_active",
    resultAvailable: true,
    result: "SECRET_RESPONSE_BODY",
    prompt: "SECRET_PROMPT",
    stdout: "SECRET_STDOUT",
    stderr: "SECRET_STDERR",
    token: "SECRET_TOKEN",
    errorKind: "RUNTIME_ERROR",
    startedAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:01.000Z",
  },
};

function request(panel, { method = "GET", path, headers = {}, token = panel.token } = {}) {
  const url = new URL(path, `http://127.0.0.1:${panel.port}`);
  if (token) url.searchParams.set("token", token);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: panel.port,
      method,
      path: `${url.pathname}${url.search}`,
      headers: { Host: `127.0.0.1:${panel.port}`, ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("panel binds loopback only", async (t) => {
  const panel = await createPanelServer({
    client: new FakeClient({ inspectResult: { sessions: [], revision: 1, epochId: "e" } }),
    accessToken: "a".repeat(32),
  });
  t.after(() => panel.close());
  assert.equal(panel.host, "127.0.0.1");
  assert.equal(panel.server.address().address, "127.0.0.1");
  await assert.rejects(() => createPanelServer({ host: "0.0.0.0", client: new FakeClient() }), /loopback/i);
});

test("non-GET/HEAD requests are rejected", async (t) => {
  const panel = await createPanelServer({
    client: new FakeClient({ inspectResult: { sessions: [] } }),
    accessToken: "b".repeat(32),
  });
  t.after(() => panel.close());
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await request(panel, { method, path: "/api/status" });
    assert.equal(res.status, 405, method);
  }
  const head = await request(panel, { method: "HEAD", path: "/" });
  assert.equal(head.status, 200);
});

test("illegal Host and invalid access token are rejected", async (t) => {
  const panel = await createPanelServer({
    client: new FakeClient({ inspectResult: { sessions: [] } }),
    accessToken: "c".repeat(32),
  });
  t.after(() => panel.close());
  const badHost = await request(panel, {
    path: "/api/status",
    headers: { Host: "evil.example" },
  });
  assert.equal(badHost.status, 403);
  const badToken = await request(panel, { path: "/api/status", token: "nope" });
  assert.equal(badToken.status, 401);
});

test("sanitized API and handoff omit forbidden fields", async (t) => {
  const panel = await createPanelServer({
    client: new FakeClient({ inspectResult: runningInspect }),
    accessToken: "d".repeat(32),
  });
  t.after(() => panel.close());
  const status = await request(panel, { path: "/api/status" });
  assert.equal(status.status, 200);
  const payload = JSON.parse(status.body);
  assert.equal(payload.daemonOnline, true);
  assert.equal(payload.selectedRun.resultAvailable, true);
  assert.deepEqual(containsForbiddenFields(payload), []);
  assert.equal(JSON.stringify(payload).includes("SECRET_"), false);
  const handoffRes = await request(panel, { path: "/api/handoff", token: panel.token });
  const handoff = JSON.parse(handoffRes.body);
  assert.equal(handoff.schemaVersion, 1);
  assert.equal(handoff.sessionId, "agy-1");
  assert.equal(handoff.conversationId, "conv-1");
  assert.deepEqual(containsForbiddenFields(handoff), []);
  assert.equal(Object.hasOwn(handoff, "prompt"), false);
  assert.equal(Object.hasOwn(handoff, "result"), false);
});

test("page has no mutation controls", () => {
  const html = renderPanelPage();
  assert.match(html, /Read-only local panel/i);
  assert.doesNotMatch(html, /<textarea/i);
  assert.doesNotMatch(html, /<form/i);
  assert.doesNotMatch(html, /id="send"|id="resume"|id="cancel"|name="prompt"|cancel_turn|close_session/i);
  assert.doesNotMatch(html, /https?:\/\/fonts|cdn\.|googleapis/i);
  assert.match(html, /Copy handoff JSON/);
  assert.match(html, /method: "GET"/);
});

test("offline empty running and uncertain states are correct", async () => {
  assert.equal(publicLifecycle("running"), "running");
  assert.equal(publicLifecycle("needs_attention"), "uncertain");
  assert.equal(publicLifecycle("idle"), "idle");
  assert.equal(publicLifecycle("closed"), "closed");
  const offline = await readPanelState(new FakeClient({ online: false }));
  assert.equal(offline.daemonOnline, false);
  assert.equal(offline.sessions.length, 0);
  assert.equal(offline.errorKind, "unavailable");
  const empty = await readPanelState(new FakeClient({ inspectResult: { sessions: [], revision: 1, epochId: "e" } }));
  assert.equal(empty.daemonOnline, true);
  assert.equal(empty.sessions.length, 0);
  const running = await readPanelState(new FakeClient({ inspectResult: runningInspect }));
  assert.equal(running.selectedSession.lifecycle, "running");
  const uncertainInspect = structuredClone(runningInspect);
  uncertainInspect.session.status = "needs_attention";
  uncertainInspect.sessions[0].status = "needs_attention";
  uncertainInspect.run.status = "unknown_after_restart";
  const uncertain = await readPanelState(new FakeClient({ inspectResult: uncertainInspect }));
  assert.equal(uncertain.selectedSession.lifecycle, "uncertain");
  assert.equal(uncertain.selectedRun.lifecycle, "uncertain");
  assert.equal(sanitizeSession(runningInspect.session).lifecycle, "running");
  assert.equal(sanitizeRun(runningInspect.run).errorKind, "RUNTIME_ERROR");
  const handoff = buildHandoffPayload({ session: running.selectedSession, run: running.selectedRun });
  assert.equal(handoff.runId, "run-1");
  assert.equal(isAllowedHost("evil.example", 1234), false);
  assert.equal(isAllowedHost("127.0.0.1:1234", 1234), true);
});