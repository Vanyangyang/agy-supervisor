import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import vm from "node:vm";
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
  constructor({ online = true, inspectResult = null, pingResult = null } = {}) {
    this.online = online;
    this.inspectResult = inspectResult;
    this.pingResult = pingResult;
    this.inspectCalls = [];
  }
  async ping() {
    if (!this.online) {
      const error = new Error("unavailable");
      error.kind = "unavailable";
      throw error;
    }
    return this.pingResult || {
      ready: true,
      protocolVersion: this.inspectResult?.daemon?.protocolVersion ?? 1,
      runtimeVersion: this.inspectResult?.daemon?.runtimeVersion ?? "0.3.0",
    };
  }
  async inspect(params = {}) {
    this.inspectCalls.push(params);
    if (!this.online) {
      const error = new Error("unavailable");
      error.kind = "unavailable";
      throw error;
    }
    const value = this.inspectResult || {};
    if (params.sessionId) {
      const session = value.session?.sessionId === params.sessionId
        ? value.session
        : value.sessions?.find((item) => item.sessionId === params.sessionId);
      if (!session) {
        const error = new Error("session not found");
        error.kind = "SESSION_NOT_FOUND";
        throw error;
      }
      return {
        revision: value.revision,
        epochId: value.epochId,
        daemon: value.daemon,
        session,
        run: value.run?.sessionId === params.sessionId ? value.run : null,
      };
    }
    return {
      revision: value.revision,
      epochId: value.epochId,
      daemon: value.daemon,
      sessions: value.sessions || (value.session ? [value.session] : []),
      omittedSessions: value.omittedSessions || 0,
    };
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
    requestId: "SECRET_REQUEST_ID",
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

const multiSessionInspect = {
  ...runningInspect,
  omittedSessions: 2,
  sessions: [
    runningInspect.sessions[0],
    {
      ...runningInspect.sessions[0],
      sessionId: "agy-2",
      conversationId: "conv-2",
      status: "idle",
      activeRunId: null,
      updatedAt: "2026-09-03T23:59:59.000Z",
    },
  ],
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
    accessToken: "a".repeat(64),
  });
  t.after(() => panel.close());
  assert.equal(panel.host, "127.0.0.1");
  assert.equal(panel.server.address().address, "127.0.0.1");
  await assert.rejects(() => createPanelServer({ host: "0.0.0.0", client: new FakeClient() }), /loopback/i);
  await assert.rejects(() => createPanelServer({ accessToken: "short", client: new FakeClient() }), /panel_access_token_invalid/);
});

test("non-GET/HEAD requests are rejected", async (t) => {
  const panel = await createPanelServer({
    client: new FakeClient({ inspectResult: { sessions: [] } }),
    accessToken: "b".repeat(64),
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
    accessToken: "c".repeat(64),
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
    accessToken: "d".repeat(64),
  });
  t.after(() => panel.close());
  const status = await request(panel, { path: "/api/status" });
  assert.equal(status.status, 200);
  const payload = JSON.parse(status.body);
  assert.equal(payload.daemonOnline, true);
  assert.equal(payload.selectedRun.resultAvailable, true);
  assert.equal(Object.hasOwn(payload.selectedRun, "requestId"), false);
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
  assert.equal(Object.hasOwn(handoff, "requestId"), false);
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
  assert.match(html, /let loadGeneration = 0/);
  assert.match(html, /generation !== loadGeneration/);
  assert.match(html, /if \(!response\.ok\)/);
  assert.match(html, /Status unavailable; handoff cleared/);
  assert.match(html, /id="copy-handoff" disabled/);
  assert.match(html, /getElementById\("empty-state"\)\.hidden = true/);
  assert.doesNotMatch(html, /sessions\[0\]\?\.sessionId \|\| ""/);
});

test("offline empty running and uncertain states are correct", async () => {
  assert.equal(publicLifecycle("running"), "running");
  assert.equal(publicLifecycle("needs_attention"), "uncertain");
  assert.equal(publicLifecycle("idle"), "idle");
  assert.equal(publicLifecycle("closed"), "closed");
  assert.equal(publicLifecycle("future_unreviewed_state"), "uncertain");
  const offline = await readPanelState(new FakeClient({ online: false }));
  assert.equal(offline.daemonOnline, false);
  assert.equal(offline.sessions.length, 0);
  assert.equal(offline.errorKind, "unavailable");
  const empty = await readPanelState(new FakeClient({
    inspectResult: {
      sessions: [],
      revision: 1,
      epochId: "e",
      daemon: { protocolVersion: 1, runtimeVersion: "0.3.0" },
    },
  }));
  assert.equal(empty.daemonOnline, true);
  assert.equal(empty.sessions.length, 0);
  const running = await readPanelState(new FakeClient({ inspectResult: runningInspect }));
  assert.equal(running.selectedSession.lifecycle, "running");
  assert.equal(running.selectedRun.runId, "run-1");
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
  assert.equal(Object.hasOwn(handoff, "requestId"), false);
  assert.equal(isAllowedHost("evil.example", 1234), false);
  assert.equal(isAllowedHost("127.0.0.1:1234", 1234), true);
});

test("panel keeps the bounded session list while loading selected run detail", async () => {
  const client = new FakeClient({ inspectResult: multiSessionInspect });
  const state = await readPanelState(client);
  assert.deepEqual(state.sessions.map((session) => session.sessionId), ["agy-1", "agy-2"]);
  assert.equal(state.omittedSessions, 2);
  assert.equal(state.selectedRun.runId, "run-1");
  assert.equal(state.handoff.runId, "run-1");
  assert.deepEqual(client.inspectCalls, [{}, { sessionId: "agy-1" }]);

  const missing = await readPanelState(client, { sessionId: "missing" });
  assert.equal(missing.daemonOnline, true);
  assert.equal(missing.errorKind, "SESSION_NOT_FOUND");
  assert.equal(missing.sessions.length, 2);
  assert.equal(missing.selectedSession, null);
  assert.equal(missing.selectedRun, null);
});

test("panel fails closed for an incompatible daemon", async () => {
  const client = new FakeClient({
    inspectResult: runningInspect,
    pingResult: { ready: true, protocolVersion: 1, runtimeVersion: "0.2.0" },
  });
  const state = await readPanelState(client);
  assert.equal(state.daemonOnline, false);
  assert.equal(state.errorKind, "runtime_version_mismatch");
  assert.deepEqual(client.inspectCalls, []);
});

test("panel validates every inspect snapshot and rejects epoch changes", async () => {
  const ping = async () => ({ ready: true, protocolVersion: 1, runtimeVersion: "0.3.0" });
  const list = {
    revision: 7,
    epochId: "epoch-old",
    daemon: { protocolVersion: 1, runtimeVersion: "0.3.0" },
    sessions: runningInspect.sessions,
  };
  const detail = {
    revision: 8,
    epochId: "epoch-new",
    daemon: { protocolVersion: 1, runtimeVersion: "0.3.0" },
    session: runningInspect.session,
    run: runningInspect.run,
  };
  const restarted = await readPanelState({
    ping,
    inspect: async (params) => (params.sessionId ? detail : list),
  });
  assert.equal(restarted.daemonOnline, false);
  assert.equal(restarted.errorKind, "DAEMON_RESTARTED");

  const staleRuntime = await readPanelState({
    ping,
    inspect: async () => ({ ...list, daemon: { protocolVersion: 1, runtimeVersion: "0.2.0" } }),
  });
  assert.equal(staleRuntime.daemonOnline, false);
  assert.equal(staleRuntime.errorKind, "runtime_version_mismatch");

  const badDetailProtocol = await readPanelState({
    ping,
    inspect: async (params) => (params.sessionId
      ? { ...detail, epochId: list.epochId, daemon: { protocolVersion: 2, runtimeVersion: "0.3.0" } }
      : list),
  });
  assert.equal(badDetailProtocol.daemonOnline, false);
  assert.equal(badDetailProtocol.errorKind, "protocol_mismatch");
});

test("page ignores stale refreshes and clears handoff after the latest failure", async () => {
  const script = renderPanelPage().match(/<script>\n([\s\S]*?)\n<\/script>/u)?.[1];
  assert.ok(script);
  const nodes = new Map();
  const makeElement = (id) => ({
    id,
    textContent: "",
    className: "",
    hidden: false,
    disabled: false,
    value: id === "option" ? undefined : "",
    checked: id === "auto-refresh",
    children: [],
    listeners: {},
    replaceChildren(...children) {
      this.children = children;
      this.value = children.length === 1
        ? (children[0].value ?? children[0].textContent)
        : "";
    },
    append(...children) {
      this.children.push(...children);
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  });
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, makeElement(id));
      return nodes.get(id);
    },
    createElement(tag) {
      return makeElement(tag);
    },
  };
  const pending = [];
  const fetch = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  vm.runInNewContext(script, {
    document,
    fetch,
    location: { search: `?token=${"a".repeat(64)}` },
    navigator: { clipboard: { writeText: async () => {} } },
    URLSearchParams,
    setInterval: () => 1,
    clearInterval: () => {},
  });
  assert.equal(pending.length, 1);
  nodes.get("refresh").listeners.click();
  assert.equal(pending.length, 2);

  const payload = (revision) => ({
    daemonOnline: true,
    errorKind: null,
    epochId: "epoch-1",
    revision,
    supervisorVersion: "0.3.0",
    protocolVersion: 1,
    sessions: [{ sessionId: "agy-1", status: "idle", lifecycle: "idle" }],
    omittedSessions: revision === 2 ? 2 : 0,
    selectedSession: { sessionId: "agy-1", status: "idle", lifecycle: "idle" },
    selectedRun: null,
    handoff: { schemaVersion: 1, revision },
  });
  pending[1].resolve({ ok: true, json: async () => payload(2) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(nodes.get("handoff-preview").textContent, /"revision": 2/);
  assert.equal(nodes.get("copy-handoff").disabled, false);
  assert.equal(nodes.get("omitted-state").textContent, "2 additional sessions omitted.");

  pending[0].resolve({ ok: true, json: async () => payload(1) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(nodes.get("handoff-preview").textContent, /"revision": 2/);

  nodes.get("refresh").listeners.click();
  pending[2].resolve({
    ok: true,
    json: async () => ({
      ...payload(3),
      sessions: [],
      omittedSessions: 0,
      selectedSession: null,
      handoff: { schemaVersion: 1, sessionId: null, revision: 3 },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nodes.get("empty-state").hidden, false);

  nodes.get("refresh").listeners.click();
  pending[3].reject(new Error("offline"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nodes.get("empty-state").hidden, true);
  assert.equal(nodes.get("session-select").value, "");
  assert.equal(nodes.get("handoff-preview").textContent, "{}");
  assert.equal(nodes.get("copy-handoff").disabled, true);

  nodes.get("refresh").listeners.click();
  pending[4].resolve({
    ok: true,
    json: async () => ({
      daemonOnline: true,
      errorKind: "SESSION_NOT_FOUND",
      epochId: "epoch-1",
      revision: 3,
      supervisorVersion: "0.3.0",
      protocolVersion: 1,
      sessions: [
        { sessionId: "agy-1", status: "idle", lifecycle: "idle" },
        { sessionId: "agy-2", status: "idle", lifecycle: "idle" },
      ],
      omittedSessions: 0,
      selectedSession: null,
      selectedRun: null,
      handoff: { schemaVersion: 1, sessionId: null, revision: 3 },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nodes.get("session-select").value, "");
  assert.equal(nodes.get("error-state").hidden, false);
  assert.match(nodes.get("error-state").textContent, /SESSION_NOT_FOUND/);
  assert.match(nodes.get("handoff-preview").textContent, /"sessionId": null/);
  assert.equal(nodes.get("handoff-preview").textContent.includes("agy-1"), false);
  assert.equal(nodes.get("copy-handoff").disabled, false);
});
